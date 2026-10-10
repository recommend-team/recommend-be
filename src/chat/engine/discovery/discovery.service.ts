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
import { buildDiscoveryPrompt } from './prompt';
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
  /** A buyer who has paid before, by first name. Null for anyone else. */
  buyerFirstName?: string | null;
  /** Recent turns, oldest first. Trimmed to the configured window. */
  history: ChatMessage[];
}

export interface DiscoveryResult {
  messages: OutboundMessage[];
  resolvedAreaId: string | null;
  usedFallback: boolean;
  modelFailed: boolean;
  foundNothing: boolean;
  /** The model asked for a teammate, and why. The engine decides whether to honour it. */
  handover: string | null;
  /** The buyer asked for a person in so many words — hand over without asking first. */
  buyerAskedForPerson: boolean;
}

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxHistory: number;
  private readonly maxToolRounds: number;
  private readonly prompt: string;

  constructor(
    private readonly configService: ConfigService,
    @Inject(CATALOG_PORT) private readonly catalog: CatalogPort,
    @Inject(LOCATION_PORT) private readonly locations: LocationPort,
  ) {
    const apiKey = this.configService.get<string>('openai.apiKey');
    this.model =
      this.configService.get<string>('openai.model') ?? 'gpt-4-turbo-preview';
    this.temperature =
      this.configService.get<number>('openai.temperature') ?? 0.6;
    this.prompt = buildDiscoveryPrompt(
      this.configService.get<string>('chat.assistantName') ?? 'James',
    );
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

  /**
   * Whether replies come from the model. Without one, greetings and small talk get the
   * engine's fixed replies — keyword search has nothing to say to "how far".
   */
  hasModel(): boolean {
    return this.client !== null;
  }

  async discover(request: DiscoveryRequest): Promise<DiscoveryResult> {
    if (!this.client) {
      return this.keywordFallback(request, false);
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
      return this.keywordFallback(request, true);
    }
  }

  // ─── Model path ─────────────────────────────────────────────────────────────

  private async runModel(
    client: OpenAI,
    request: DiscoveryRequest,
  ): Promise<DiscoveryResult> {
    const harvest = emptyHarvest();
    const named = await this.areaNamedIn(request.text);
    const areaId = named ?? request.areaId;
    if (named && named !== request.areaId) harvest.resolvedAreaId = named;

    const context = {
      catalog: this.catalog,
      locations: this.locations,
      areaId,
      buyerText: recentBuyerText(request),
    };

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: this.prompt },
      ...(areaId
        ? [
            {
              role: 'system' as const,
              content:
                `The buyer's area is ${areaId}. Do not ask which area they are in. ` +
                `If they name a different area, call resolve_area with it and search there instead.`,
            },
          ]
        : []),
      ...(request.buyerFirstName
        ? [
            {
              role: 'system' as const,
              content:
                `The buyer is ${request.buyerFirstName}, who has ordered before. Greet them by name ` +
                `("Hi ${request.buyerFirstName}!") when they say hello. Never ask for their name, phone ` +
                'number or address — checkout already has them.',
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

      if (harvest.handoverReason) break;

      // Out of rounds with tools still pending — stop rather than loop forever.
      if (round === this.maxToolRounds) {
        this.logger.warn(
          `Hit the ${this.maxToolRounds}-round tool limit; answering with what we have`,
        );
      }
    }

    return this.assemble(reply, harvest, {
      usedFallback: false,
      modelFailed: false,
    });
  }
  private async areaNamedIn(text: string): Promise<string | null> {
    try {
      const areas = await this.locations.searchAreas(text);
      return areas.length === 1 ? areas[0].id : null;
    } catch (error) {
      this.logger.warn(
        `Could not pre-resolve an area from "${text}": ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return null;
    }
  }

  // ─── Keyword fallback ───────────────────────────────────────────────────────

  /**
   * No model: match the message against product names directly. Less graceful, but it
   * returns the same real data, so the product is usable without an API key.
   */
  private async keywordFallback(
    request: DiscoveryRequest,
    modelFailed: boolean,
  ): Promise<DiscoveryResult> {
    const harvest = emptyHarvest();
    harvest.searched = true;

    // Same rule as the model path: an area the buyer just named beats the one we
    // remembered, so saying "in Egbeda" moves the search to Egbeda.
    const areas = await this.locations.searchAreas(request.text);

    // A place the buyer named says where, not what. Left in, every word has to match a
    // dish, and "jollof in Lekki" finds nothing — no dish is called Lekki.
    const placeWords = new Set(
      areas.flatMap((area) => area.name.toLowerCase().split(/[^a-z0-9]+/)),
    );
    const query = stripFiller(request.text)
      .split(' ')
      .filter((word) => word && !placeWords.has(word))
      .join(' ');
    let areaId = request.areaId;

    if (areas.length === 1) {
      if (areas[0].id !== areaId) harvest.resolvedAreaId = areas[0].id;
      areaId = areas[0].id;
    } else if (!areaId) {
      // Several possible areas and nothing established — offer them the choice.
      harvest.areas.push(...areas);
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
          ? 'I could not match that exactly, but these vendors are near you:'
          : `I could not find anything matching "${query || request.text}". Try another search, or tell me which area you're in.`;

    return this.assemble(reply, harvest, { usedFallback: true, modelFailed });
  }

  // ─── Shared assembly ────────────────────────────────────────────────────────

  /**
   * Turns model prose plus tool output into what actually gets sent, enforcing the
   * rule that no number reaches the buyer unless a tool produced it.
   */
  private assemble(
    reply: string,
    harvest: ToolHarvest,
    {
      usedFallback,
      modelFailed,
    }: { usedFallback: boolean; modelFailed: boolean },
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
          : 'Let me know what you are looking for and roughly where you are.';
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

    return {
      messages,
      resolvedAreaId: harvest.resolvedAreaId,
      usedFallback,
      modelFailed,
      // Only a search that came back empty. A turn of small talk searched for nothing,
      // so it found nothing — that is not the assistant struggling, and counting it
      // used to hand a buyer over for asking "who are you?".
      foundNothing:
        harvest.searched &&
        harvest.products.length === 0 &&
        harvest.vendors.length === 0,
      handover: harvest.handoverReason,
      buyerAskedForPerson: harvest.buyerAskedForPerson,
    };
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
  'in',
  'at',
  'by',
  'from',
  'inside',
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

const BUYER_TURNS_FOR_INTENT = 3;

function recentBuyerText(request: DiscoveryRequest): string {
  const previous = request.history
    .filter((message) => message.author === MessageAuthor.BUYER)
    .slice(-BUYER_TURNS_FOR_INTENT)
    .map((message) => message.text);

  return [request.text, ...previous.reverse()].join(' ');
}
