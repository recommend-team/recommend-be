import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { CATALOG_PORT } from '../../ports/catalog.port';
import type { CatalogPort } from '../../ports/catalog.port';
import { LOCATION_PORT } from '../../ports/location.port';
import type { LocationPort } from '../../ports/location.port';
import { OutboundMessage } from '../../transport/channel.interface';
import { ChatMessage } from '../../conversation/entities/message.entity';
import { MessageAuthor } from '../../enums/chat.enums';
import { DISCOVERY_SYSTEM_PROMPT } from './prompt';
import {
  DISCOVERY_TOOLS,
  ToolHarvest,
  emptyHarvest,
  executeTool,
} from './tools';
import { enforcePriceIntegrity } from './price-guard';
import {
  areaChoicesPayload,
  productListPayload,
  vendorListPayload,
} from '../payloads';

export interface DiscoveryRequest {
  text: string;
  /** Area already established for this conversation, if any. */
  areaId: string | null;
  /** Recent turns, oldest first. Trimmed to the configured window. */
  history: ChatMessage[];
}

export interface DiscoveryResult {
  messages: OutboundMessage[];
  /** Set when this turn worked out where the buyer is. */
  resolvedAreaId: string | null;
  /** True when the reply came from the keyword fallback rather than the model. */
  usedFallback: boolean;
}

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxHistory: number;
  private readonly maxToolRounds: number;

  constructor(
    private readonly configService: ConfigService,
    @Inject(CATALOG_PORT) private readonly catalog: CatalogPort,
    @Inject(LOCATION_PORT) private readonly locations: LocationPort,
  ) {
    const apiKey = this.configService.get<string>('openai.apiKey');
    this.model =
      this.configService.get<string>('openai.model') ?? 'gpt-4-turbo-preview';
    this.temperature =
      this.configService.get<number>('openai.temperature') ?? 0.2;
    this.maxHistory =
      this.configService.get<number>('chat.maxHistoryMessages') ?? 12;
    this.maxToolRounds =
      this.configService.get<number>('chat.maxToolRounds') ?? 3;

    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    if (!this.client) {
      this.logger.warn(
        'OPENAI_API_KEY is not set — discovery is running on keyword search only',
      );
    }
  }

  async discover(request: DiscoveryRequest): Promise<DiscoveryResult> {
    if (!this.client) {
      return this.keywordFallback(request);
    }

    try {
      return await this.runModel(this.client, request);
    } catch (error) {
      // A model outage must not take the chat down. Degrade to keyword search and
      // let the buyer keep going.
      this.logger.error(
        `Discovery model call failed, falling back to keyword search: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return this.keywordFallback(request);
    }
  }

  // ─── Model path ─────────────────────────────────────────────────────────────

  private async runModel(
    client: OpenAI,
    request: DiscoveryRequest,
  ): Promise<DiscoveryResult> {
    const harvest = emptyHarvest();
    const context = {
      catalog: this.catalog,
      locations: this.locations,
      areaId: request.areaId,
    };

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: DISCOVERY_SYSTEM_PROMPT },
      ...(request.areaId
        ? [
            {
              role: 'system' as const,
              content: `The buyer's area is already known (areaId: ${request.areaId}). Do not ask again.`,
            },
          ]
        : []),
      ...this.toModelHistory(request.history),
      { role: 'user', content: request.text },
    ];

    let reply = '';

    for (let round = 0; round <= this.maxToolRounds; round++) {
      const completion = await client.chat.completions.create({
        model: this.model,
        temperature: this.temperature,
        messages,
        tools: DISCOVERY_TOOLS as ChatCompletionTool[],
      });

      const choice = completion.choices[0]?.message;
      if (!choice) break;

      const toolCalls = choice.tool_calls ?? [];

      if (toolCalls.length === 0) {
        reply = choice.content ?? '';
        break;
      }

      messages.push(choice);

      for (const call of toolCalls) {
        if (call.type !== 'function') continue;

        const args = safeParseArgs(call.function.arguments);
        const output = await executeTool(
          call.function.name,
          args,
          context,
          harvest,
        );

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: output,
        });
      }

      // Out of rounds with tools still pending — stop rather than loop forever.
      if (round === this.maxToolRounds) {
        this.logger.warn(
          `Hit the ${this.maxToolRounds}-round tool limit; answering with what we have`,
        );
      }
    }

    return this.assemble(reply, harvest, false);
  }

  // ─── Keyword fallback ───────────────────────────────────────────────────────

  /**
   * No model: match the message against dish names directly. Less graceful, but it
   * returns the same real data, so the product is usable without an API key.
   */
  private async keywordFallback(
    request: DiscoveryRequest,
  ): Promise<DiscoveryResult> {
    const harvest = emptyHarvest();
    const query = stripFiller(request.text);

    let areaId = request.areaId;
    if (!areaId) {
      const areas = await this.locations.searchAreas(request.text);
      harvest.areas.push(...areas);
      if (areas.length === 1) {
        areaId = areas[0].id;
        harvest.resolvedAreaId = areas[0].id;
      }
    }

    const products = await this.catalog.searchProducts({
      text: query || undefined,
      areaId: areaId ?? undefined,
    });
    harvest.products.push(...products);
    harvest.prices.push(...products.map((product) => product.price));

    if (products.length === 0) {
      const vendors = await this.catalog.searchVendors({
        text: query || undefined,
        areaId: areaId ?? undefined,
      });
      harvest.vendors.push(...vendors);
    }

    const reply =
      harvest.products.length > 0
        ? "Here's what I found:"
        : harvest.vendors.length > 0
          ? 'I could not match that dish, but these stores are near you:'
          : `I could not find anything matching "${query || request.text}". Try another dish, or tell me which area you're in.`;

    return this.assemble(reply, harvest, true);
  }

  // ─── Shared assembly ────────────────────────────────────────────────────────

  /**
   * Turns model prose plus tool output into what actually gets sent, enforcing the
   * rule that no number reaches the buyer unless a tool produced it.
   */
  private assemble(
    reply: string,
    harvest: ToolHarvest,
    usedFallback: boolean,
  ): DiscoveryResult {
    const guarded = enforcePriceIntegrity(reply, harvest.prices);

    if (guarded.violations.length > 0) {
      this.logger.warn(
        `Dropped ${guarded.violations.length} invented price(s) from a reply: ${guarded.violations.join(', ')}`,
      );
    }

    let text = guarded.text.trim();
    if (!text) {
      text =
        harvest.products.length > 0 || harvest.vendors.length > 0
          ? "Here's what I found:"
          : 'Let me know what you would like to eat and roughly where you are.';
    }

    const messages: OutboundMessage[] = [];

    if (harvest.products.length > 0) {
      messages.push({ text, payload: productListPayload(harvest.products) });
    } else if (harvest.vendors.length > 0) {
      messages.push({ text, payload: vendorListPayload(harvest.vendors) });
    } else if (harvest.areas.length > 1) {
      messages.push({ text, payload: areaChoicesPayload(harvest.areas) });
    } else {
      messages.push({ text });
    }

    return { messages, resolvedAreaId: harvest.resolvedAreaId, usedFallback };
  }

  private toModelHistory(history: ChatMessage[]): ChatCompletionMessageParam[] {
    return history.slice(-this.maxHistory).map((message) => ({
      role:
        message.author === MessageAuthor.BUYER
          ? ('user' as const)
          : ('assistant' as const),
      content: message.text,
    }));
  }
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const FILLER = new Set([
  'i',
  'want',
  'need',
  'looking',
  'for',
  'some',
  'a',
  'an',
  'the',
  'me',
  'please',
  'abeg',
  'get',
  'buy',
  'order',
  'to',
  'of',
  'my',
  'is',
  'are',
  'do',
  'you',
  'have',
  'any',
  'can',
  'give',
  'like',
  'would',
  'near',
  'around',
]);

/** Crude but predictable: drop filler words so "I want some jollof" searches "jollof". */
function stripFiller(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !FILLER.has(word))
    .join(' ')
    .trim();
}
