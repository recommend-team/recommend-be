import { Injectable, Logger } from '@nestjs/common';
import { ConversationService } from '../conversation/conversation.service';
import { ChannelRegistry } from '../transport/channel.registry';
import { OutboundMessage } from '../transport/channel.interface';
import { Conversation } from '../conversation/entities/conversation.entity';
import { ConversationState } from '../enums/chat.enums';

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
 * B2 is deliberately scripted — no model is involved. The LLM discovery layer lands in
 * B3 and slots in behind `composeReply`; everything around it (persistence, ordering,
 * delivery, de-duplication) is already in place and will not need to change.
 */
@Injectable()
export class EngineService {
  private readonly logger = new Logger(EngineService.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly channelRegistry: ChannelRegistry,
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

    const replies = this.composeReply(conversation, input.text);
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
        "Hi! I'm Recommend. Tell me what you're craving — jollof, pounded yam, " +
        "suya, anything — and I'll find places near you that have it.",
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
   * Scripted placeholder. B3 replaces the body of this method with LLM-driven
   * discovery over read-only catalogue tools; the signature stays the same.
   */
  private composeReply(
    conversation: Conversation,
    text: string,
  ): OutboundMessage[] {
    const trimmed = text.trim();

    if (!trimmed) {
      return [{ text: "I didn't catch that — what are you looking for?" }];
    }

    if (conversation.state !== ConversationState.DISCOVERY) {
      // No flow can move a conversation out of DISCOVERY yet, so reaching here means
      // state was set by something that no longer exists. Say something useful
      // rather than nothing.
      this.logger.warn(
        `Conversation ${conversation.id} is in ${conversation.state} with no flow to handle it`,
      );
      return [
        { text: "Let's start again — what would you like to order today?" },
      ];
    }

    if (isGreeting(trimmed)) {
      return [
        {
          text: 'Hello! What would you like to eat? Tell me the dish and roughly where you are.',
        },
      ];
    }

    return [
      {
        text:
          `Got it — you're after "${trimmed}". I'm still learning to search our ` +
          'restaurants; that lands shortly. In the meantime you can browse stores ' +
          "directly and I'll keep track of this chat.",
      },
    ];
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
