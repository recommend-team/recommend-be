import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConversationService } from '../conversation/conversation.service';
import { ChannelRegistry } from '../transport/channel.registry';
import { OutboundMessage } from '../transport/channel.interface';
import {
  Conversation,
  PendingCartLine,
} from '../conversation/entities/conversation.entity';
import { ChatMessage } from '../conversation/entities/message.entity';
import { MessageAuthor } from '../enums/chat.enums';
import { CheckoutFlow } from './flows/checkout.flow';
import { HandoverService } from './handover.service';
import { ConversationState } from '../enums/chat.enums';
import { DiscoveryService } from './discovery/discovery.service';
import { ORDERING_PORT } from '../ports/ordering.port';
import type { BuyerOrderSummary, OrderingPort } from '../ports/ordering.port';

export interface InboundMessage {
  conversation: Conversation;
  text: string;
  clientMessageId?: string;
  /**
   * Untrusted snapshot of the client's localStorage cart, so the assistant can talk
   * about the basket. Never used for pricing — checkout recomputes from the database.
   */
  cart?: { itemCount: number; vendorCount: number };
}

/**
 * Routes an inbound message to a reply.
 *
 * Discovery goes to the model; greetings and empty input do not, because a model call
 * that can only produce one sensible answer is wasted money. The checkout flows in B4
 * will be scripted for a stronger reason: nothing that leads to a charge should depend
 * on what a model decides to say.
 */
@Injectable()
export class EngineService {
  private readonly logger = new Logger(EngineService.name);

  /**
   * How many past messages to load for a turn.
   *
   * Read from the same setting the discovery layer trims to. Fetching fewer than that
   * silently caps the model's memory below what CHAT_MAX_HISTORY_MESSAGES advertises —
   * raising the setting alone would then change nothing at all.
   */
  private readonly historyLimit: number;

  constructor(
    private readonly conversationService: ConversationService,
    private readonly channelRegistry: ChannelRegistry,
    private readonly discoveryService: DiscoveryService,
    private readonly checkoutFlow: CheckoutFlow,
    private readonly handover: HandoverService,
    private readonly configService: ConfigService,
    @Inject(ORDERING_PORT) private readonly ordering: OrderingPort,
  ) {
    this.historyLimit =
      this.configService.get<number>('chat.maxHistoryMessages') ?? 12;
    this.assistantName =
      this.configService.get<string>('chat.assistantName') ?? 'James';
  }

  /** Same setting the discovery prompt reads, so the greeting and the persona agree. */
  private readonly assistantName: string;

  /**
   * The full round trip: persist the buyer's message, work out a reply, persist it,
   * then hand it to the channel. Persisting before sending is what makes a dropped
   * socket harmless — the client picks the reply up from history on reconnect.
   */
  async handleInbound(input: InboundMessage): Promise<OutboundMessage[]> {
    const { conversation } = input;

    const inbound = await this.conversationService.recordInbound({
      conversationId: conversation.id,
      text: input.text,
      clientMessageId: input.clientMessageId,
    });

    // A retry of a message we have already answered. Staying silent is correct —
    // replying again would double up in the client's thread.
    if (!inbound) return [];

    // A person is answering. The message is on the record and visible to them; the
    // assistant simply does not speak over it. Checked after recording, never before —
    // a held conversation must still capture everything the buyer says.
    if (await this.handover.shouldStaySilent(conversation)) {
      this.logger.debug(
        `Conversation ${conversation.id} is held by an admin — not replying`,
      );
      this.handover.announceBuyerWaiting(conversation, input.text);
      return [];
    }

    const handover = await this.handover.awaitingTeammate(conversation);
    if (handover === 'waiting') {
      this.logger.debug(
        `Conversation ${conversation.id} is waiting for a teammate — not replying`,
      );
      return [];
    }

    if (input.cart) {
      await this.conversationService.mergeContext(conversation.id, {
        lastCartSnapshot: input.cart,
      });
    }

    const replies = await this.composeReply(
      conversation,
      input.text,
      inbound.id,
    );
    return this.deliver(
      conversation,
      handover === 'expired'
        ? [{ text: SORRY_FOR_THE_WAIT }, ...replies]
        : replies,
    );
  }

  private async deliver(
    conversation: Conversation,
    replies: OutboundMessage[],
  ): Promise<OutboundMessage[]> {
    const delivered: OutboundMessage[] = [];

    for (const reply of replies) {
      const persisted = await this.conversationService.recordOutbound({
        conversationId: conversation.id,
        text: reply.text,
        payload: reply.payload,
      });

      const outbound: OutboundMessage = {
        ...reply,
        messageId: persisted.id,
        createdAt: persisted.createdAt,
      };

      await this.channelRegistry.send(
        conversation.channel,
        conversation.channelAddress,
        outbound,
      );

      delivered.push(outbound);
    }

    return delivered;
  }

  /** The greeting a device gets when its conversation is brand new. */
  async greet(conversation: Conversation): Promise<OutboundMessage> {
    const reply: OutboundMessage = {
      text:
        `Hi! I'm ${this.assistantName} from Recommend. ` +
        'What can I find for you today? Food, gadgets, anything at all — ' +
        "tell me, and roughly where you are, and I'll find who has it near you.",
    };

    const persisted = await this.conversationService.recordOutbound({
      conversationId: conversation.id,
      text: reply.text,
    });

    const outbound: OutboundMessage = {
      ...reply,
      messageId: persisted.id,
      createdAt: persisted.createdAt,
    };

    await this.channelRegistry.send(
      conversation.channel,
      conversation.channelAddress,
      outbound,
    );

    return outbound;
  }

  /**
   * Discovery: the LLM answers, but only ever about what the catalogue tools returned.
   *
   * Greetings go to the model too, when there is one — "how far" deserves a reply from a
   * person, not the same sentence every time. Without a model, and mid-checkout (which is
   * scripted), a greeting gets a fixed, friendly line. The money path stays scripted:
   * nothing that leads to a charge depends on what a model decides to say.
   */
  private async composeReply(
    conversation: Conversation,
    text: string,
    inboundId: string | null,
  ): Promise<OutboundMessage[]> {
    const trimmed = text.trim();

    if (!trimmed) {
      return [
        { text: "Sorry, I didn't catch that — what are you looking for?" },
      ];
    }

    const conversational =
      conversation.state === ConversationState.DISCOVERY &&
      this.discoveryService.hasModel();

    if (isGreeting(trimmed) && !conversational) {
      return [
        {
          text:
            `Hello, I'm ${this.assistantName} from Recommend. What are you looking for ` +
            'today, and which area are you in?',
        },
      ];
    }

    if (conversation.state === ConversationState.DISCOVERY) {
      return this.discover(conversation, trimmed, inboundId);
    }

    // Any other state means a checkout is in progress, and that path is scripted —
    // no model decides a quantity, an address or a total.
    return this.checkoutFlow.handle(conversation, trimmed);
  }

  /**
   * The buyer tapped Pay. Recorded as a normal buyer turn so the thread reads as one
   * continuous conversation rather than a form appearing out of nowhere.
   */
  async startCheckout(
    conversation: Conversation,
    cart: PendingCartLine[],
    text = "I'd like to pay",
  ): Promise<OutboundMessage[]> {
    await this.conversationService.recordInbound({
      conversationId: conversation.id,
      text,
    });

    const replies = await this.checkoutFlow.start(conversation, cart);
    return this.deliver(conversation, replies);
  }

  /**
   * The buyer verified their email in the checkout's receipt card. Signing in happened
   * beside the conversation, so the checkout is moved on here — the next question
   * arrives as if they had answered.
   */
  async continueCheckoutAfterSignIn(
    conversation: Conversation,
  ): Promise<OutboundMessage[]> {
    const replies = await this.checkoutFlow.continueAfterSignIn(conversation);
    return this.deliver(conversation, replies);
  }

  /** Every order this device has placed, newest first. */
  async listOrders(conversationId: string): Promise<BuyerOrderSummary[]> {
    const conversation =
      await this.conversationService.findById(conversationId);
    const references = conversation?.context?.orderReferences ?? [];
    return this.ordering.listOrders(references);
  }

  /**
   * The buyer confirming they have their order.
   *
   * The reference must be one this conversation placed. Anything else is refused
   * outright rather than attempted — a device knowing a reference is not the same as a
   * device owning the order, and completion is what releases a vendor's money.
   */
  async completeOrder(
    conversationId: string,
    reference: string,
  ): Promise<BuyerOrderSummary[]> {
    const conversation =
      await this.conversationService.findById(conversationId);
    const references = conversation?.context?.orderReferences ?? [];

    if (!references.includes(reference)) {
      throw new Error(`Conversation does not own order ${reference}`);
    }

    await this.ordering.completeOrder(reference);
    return this.ordering.listOrders(references);
  }

  /** Hands the turn to the discovery layer and records anything it learned. */
  private async discover(
    conversation: Conversation,
    text: string,
    inboundId: string | null,
  ): Promise<OutboundMessage[]> {
    const history = (
      await this.conversationService.getHistory(conversation.id, {
        limit: this.historyLimit + 1,
      })
    )
      .filter((message) => message.id !== inboundId)
      .slice(-this.historyLimit);

    const result = await this.discoveryService.discover({
      text,
      areaId: conversation.areaId,
      history,
    });

    // Remember where the buyer is so we never ask twice.
    if (
      result.resolvedAreaId &&
      result.resolvedAreaId !== conversation.areaId
    ) {
      await this.conversationService.setArea(
        conversation.id,
        result.resolvedAreaId,
      );
    }

    const struggled = result.modelFailed || result.foundNothing;
    const repeated = repeatedThemselves(history, text);

    const previousStreak = conversation.context?.strugglingTurns ?? 0;
    const streak = struggled ? previousStreak + 1 : 0;
    if (streak !== previousStreak) {
      await this.conversationService.mergeContext(conversation.id, {
        strugglingTurns: streak,
      });
      conversation.context = {
        ...conversation.context,
        strugglingTurns: streak,
      };
    }
    const handoverReason =
      result.handover ??
      (repeated
        ? 'The buyer asked the same thing twice'
        : streak >= 2
          ? 'The assistant could not help twice in a row'
          : null);

    if (handoverReason) {
      if (await this.handover.requestHandover(conversation, handoverReason)) {
        return [{ text: HANDING_OVER }];
      }

      if (result.handover) {
        await this.flagIfStruggling(conversation, struggled, repeated);
        return [{ text: CANNOT_HAND_OVER }];
      }
    }

    await this.flagIfStruggling(conversation, struggled, repeated);

    return result.messages;
  }

  /**
   * Raise a hand when the assistant is not coping — the quieter signal than a handover.
   * It sorts the conversation up the admin queue, and alerts once.
   */
  private async flagIfStruggling(
    conversation: Conversation,
    struggled: boolean,
    repeated: boolean,
  ): Promise<void> {
    if (conversation.needsAttentionAt) return;

    const reason = repeated
      ? 'The buyer asked the same thing twice'
      : struggled
        ? 'The assistant could not find what they asked for'
        : null;

    if (!reason) return;

    await this.conversationService.flagForAttention(
      conversation.id,
      reason,
      conversation.context?.profile?.name ?? null,
    );
    conversation.needsAttentionAt = new Date();
    conversation.attentionReason = reason;

    this.logger.log(
      `Conversation ${conversation.id} needs a person: ${reason.toLowerCase()}`,
    );
  }
}

/**
 * What the buyer sees when they are handed over. Never "a person", "a teammate" or "the
 * bot": they are talking to Recommend throughout (ADMIN_CHAT_PLAN.md §2).
 */
const HANDING_OVER = 'Let me check on that for you — one moment.';
const SORRY_FOR_THE_WAIT = 'Sorry to keep you waiting.';
const CANNOT_HAND_OVER =
  "I'm sorry, I can't sort that out from here just now. Is there anything I can help you find?";

/**
 * The buyer saying the same thing again.
 */
function repeatedThemselves(history: ChatMessage[], text: string): boolean {
  const previous = [...history]
    .reverse()
    .find((message) => message.author === MessageAuthor.BUYER);

  if (!previous) return false;

  const normalise = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const now = normalise(text);
  return now.length > 3 && now === normalise(previous.text);
}

const GREETINGS = [
  'hi',
  'hello',
  'hey',
  'good morning',
  'good afternoon',
  'good evening',
  'how far',
  'abeg',
];

function isGreeting(text: string): boolean {
  const normalised = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .trim();
  return GREETINGS.some(
    (greeting) =>
      normalised === greeting || normalised.startsWith(`${greeting} `),
  );
}
