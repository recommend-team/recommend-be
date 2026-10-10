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
import type { AreaSummary, LocationPort } from '../../ports/location.port';
import { ORDERING_PORT } from '../../ports/ordering.port';
import type {
  BuyerOrderSummary,
  OrderingPort,
} from '../../ports/ordering.port';
import {
  RecommendFacts,
  answerFromKnowledge,
  buildKnowledge,
  describeAreas,
} from './knowledge';
import { describeLatestOrder, orderPrices, orderProgress } from './my-orders';
import { sanitizeUntrusted } from './sanitize';
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
  /** Where their last paid delivery went, if they have one. */
  lastDeliveryAddress?: string | null;
  /** Signed in with an email, so their chats and orders follow them. */
  signedIn?: boolean;
  /** This conversation's orders — the only ones the assistant may look up. */
  orderReferences?: string[];
  /** Recent turns, oldest first. Trimmed to the configured window. */
  history: ChatMessage[];
}

/** How long the covered areas are reused before being read again. */
const FACTS_TTL_MS = 60_000;

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
    @Inject(ORDERING_PORT) private readonly ordering: OrderingPort,
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
      this.configService.get<number>('chat.maxHistoryMessages') ?? 20;
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
    const facts = await this.facts();
    // The delivery fee is in the knowledge the model is given, so it may say it.
    harvest.prices.push(facts.deliveryFee);

    const named = await this.areaNamedIn(request.text);
    const areaId = named ?? request.areaId;
    if (named && named !== request.areaId) harvest.resolvedAreaId = named;

    const context = {
      catalog: this.catalog,
      locations: this.locations,
      areaId,
      buyerText: recentBuyerText(request),
      orders: {
        port: this.ordering,
        references: request.orderReferences ?? [],
      },
    };

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: this.prompt },
      { role: 'system', content: buildKnowledge(facts) },
      { role: 'system', content: await this.aboutTheBuyer(request) },
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
  // ─── What the assistant knows ───────────────────────────────────────────────

  private cachedFacts: { facts: RecommendFacts; at: number } | null = null;

  /**
   * The facts that change without a deploy, read from the system. Areas are cached for a
   * minute — read on every reply otherwise — and a failed read keeps the last good list.
   */
  private async facts(): Promise<RecommendFacts> {
    if (this.cachedFacts && Date.now() - this.cachedFacts.at < FACTS_TTL_MS) {
      return this.cachedFacts.facts;
    }

    let servedAreas: AreaSummary[] = this.cachedFacts?.facts.servedAreas ?? [];
    try {
      servedAreas = await this.locations.listServedAreas();
    } catch (error) {
      this.logger.warn(
        `Could not read the covered areas: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }

    const facts = {
      deliveryFee: this.ordering.deliveryFeeFor('DELIVERY'),
      servedAreas,
    };
    this.cachedFacts = { facts, at: Date.now() };
    return facts;
  }

  /** A short note about who James is talking to, from what the platform knows. */
  private async aboutTheBuyer(request: DiscoveryRequest): Promise<string> {
    const lines: string[] = [];

    lines.push(
      request.buyerFirstName
        ? `- ${request.buyerFirstName}, who has ordered from us before.`
        : '- Has not ordered from us before (or not on this device). Name not known yet.',
    );
    if (request.lastDeliveryAddress) {
      // Typed by the buyer, so neutralised like any other text from outside.
      lines.push(
        `- Last delivery went to: ${sanitizeUntrusted(request.lastDeliveryAddress, 160)}`,
      );
    }
    lines.push(
      request.signedIn
        ? '- Signed in, so their chats and orders follow them across devices.'
        : '- Not signed in.',
    );

    const latest = await this.latestOrder(request.orderReferences ?? []);
    if (latest) {
      lines.push(
        `- Latest order ${latest.reference}: ${orderProgress(latest)}. ` +
          'Use get_my_orders for the details.',
      );
    }

    return `ABOUT THIS BUYER\n${lines.join('\n')}`;
  }

  private async latestOrder(
    references: string[],
  ): Promise<BuyerOrderSummary | null> {
    if (references.length === 0) return null;
    try {
      return (await this.ordering.listOrders(references))[0] ?? null;
    } catch (error) {
      this.logger.warn(
        `Could not read the buyer's orders: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return null;
    }
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
    const known = await this.answerWithoutModel(request, modelFailed);
    if (known) return known;

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

    // Nothing asked for, only where they are — "I live in Ikeja", "what can I get?". Show
    // who is there rather than searching for a dish called "live".
    if (!query) {
      return this.whoIsNear(areaId, areas, harvest, modelFailed);
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

  private async whoIsNear(
    areaId: string | null,
    named: AreaSummary[],
    harvest: ToolHarvest,
    modelFailed: boolean,
  ): Promise<DiscoveryResult> {
    const options = { usedFallback: true, modelFailed };

    if (!areaId) {
      // Not a failed search — nothing was asked for yet.
      harvest.searched = false;
      return this.assemble(
        harvest.areas.length > 1
          ? 'Which of these areas do you mean?'
          : 'What are you looking for, and which area are you in?',
        harvest,
        options,
      );
    }

    const area =
      named.find((candidate) => candidate.id === areaId) ??
      (await this.locations.getAreaById(areaId));
    harvest.vendors.push(...(await this.catalog.searchVendors({ areaId })));

    const place = area?.name ?? 'your area';
    return this.assemble(
      harvest.vendors.length > 0
        ? `Here are the vendors in ${place} — tap one to see what they have, or tell me what you're in the mood for.`
        : `We don't have vendors in ${place} yet. Tell me another area and I'll look there.`,
      harvest,
      options,
    );
  }

  /**
   * Questions about Recommend itself, answered from the same facts the model gets. Null
   * when the message is not one — it is then searched as a product, as before.
   */
  private async answerWithoutModel(
    request: DiscoveryRequest,
    modelFailed: boolean,
  ): Promise<DiscoveryResult | null> {
    const facts = await this.facts();
    const answer = answerFromKnowledge(request.text, facts);
    if (!answer) return null;

    const harvest = emptyHarvest();
    harvest.prices.push(facts.deliveryFee);
    const done = (text: string) =>
      this.assemble(text, harvest, { usedFallback: true, modelFailed });

    switch (answer.kind) {
      case 'text':
        return done(answer.text);

      case 'team':
        // Only the team can help — the engine asks whether they would like someone.
        harvest.handoverReason = answer.reason;
        return done('');

      case 'orders': {
        const references = request.orderReferences ?? [];
        let orders: BuyerOrderSummary[] = [];
        try {
          orders = references.length
            ? await this.ordering.listOrders(references)
            : [];
        } catch (error) {
          this.logger.warn(
            `Could not read the buyer's orders: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
          return done(
            "I couldn't look up your order just now — the Orders tab at the bottom of " +
              'the screen shows where it is.',
          );
        }
        harvest.prices.push(...orders.flatMap(orderPrices));
        return done(describeLatestOrder(orders));
      }

      case 'coverage': {
        const named = await this.locations.searchAreas(request.text);
        const served = new Set(facts.servedAreas.map((area) => area.id));
        const covered = named.filter((area) => served.has(area.id));

        if (named.length === 0) {
          return done(
            `Right now we have vendors in ${describeAreas(facts.servedAreas)}. ` +
              'Which area are you in?',
          );
        }
        if (covered.length > 0) {
          if (covered.length === 1) harvest.resolvedAreaId = covered[0].id;
          return done(
            `Yes — we have vendors in ${covered.map((area) => area.name).join(', ')}. ` +
              'What would you like?',
          );
        }
        return done(
          `We don't have vendors in ${named[0].name} yet. Right now we cover ` +
            `${describeAreas(facts.servedAreas)}.`,
        );
      }
    }
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
  // Saying where they are, or asking what there is — not a dish.
  'live',
  'stay',
  'staying',
  'am',
  'im',
  'based',
  'located',
  'what',
  'whats',
  'options',
  'available',
  'there',
  'anything',
  'something',
  'show',
  'see',
  'eat',
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
