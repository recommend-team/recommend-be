import { Injectable, Logger } from '@nestjs/common';
import { ConversationService } from '../conversation/conversation.service';
import { ChannelRegistry } from '../transport/channel.registry';
import { OutboundMessage } from '../transport/channel.interface';
import {
  Conversation,
  PendingCartLine,
} from '../conversation/entities/conversation.entity';
import { CheckoutFlow } from './flows/checkout.flow';
import { ConversationState } from '../enums/chat.enums';
import { DiscoveryService } from './discovery/discovery.service';

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

  constructor(
    private readonly conversationService: ConversationService,
    private readonly channelRegistry: ChannelRegistry,
    private readonly discoveryService: DiscoveryService,
    private readonly checkoutFlow: CheckoutFlow,
  ) {}

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

    if (input.cart) {
      await this.conversationService.mergeContext(conversation.id, {
        lastCartSnapshot: input.cart,
      });
    }

    const replies = await this.composeReply(conversation, input.text);
    return this.deliver(conversation, replies);
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
        "Hi! I'm Recommend."
        + "Tell me what you're looking for, anything a vendor " +
        "might sell — and I'll find who has it near you.",
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
   * Greetings and empty input are still handled without a model — instant, free, and
   * impossible to get wrong. The money path (B4) will be scripted for the same reason.
   */
  private async composeReply(
    conversation: Conversation,
    text: string,
  ): Promise<OutboundMessage[]> {
    const trimmed = text.trim();

    if (!trimmed) {
      return [{ text: "I didn't catch that — what are you looking for?" }];
    }

    if (isGreeting(trimmed)) {
      return [
        {
          text: 'Hello! What are you looking for today? Tell me the item and roughly where you are.',
        },
      ];
    }

    if (conversation.state === ConversationState.DISCOVERY) {
      return this.discover(conversation, trimmed);
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

  /** Hands the turn to the discovery layer and records anything it learned. */
  private async discover(
    conversation: Conversation,
    text: string,
  ): Promise<OutboundMessage[]> {
    const history = await this.conversationService.getHistory(conversation.id, {
      limit: 20,
    });

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

    if (result.usedFallback) {
      this.logger.debug(
        `Conversation ${conversation.id} answered by keyword fallback`,
      );
    }

    return result.messages;
  }
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
