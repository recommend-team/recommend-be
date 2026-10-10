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

    // Waiting for a person is not a reason to go quiet: the assistant keeps helping until
    // an admin actually takes the chat (above).

    if (input.cart) {
      await this.conversationService.mergeContext(conversation.id, {
        lastCartSnapshot: input.cart,
      });
    }

    const replies = await this.respond(conversation, input.text, inbound.id);
    return this.deliver(conversation, replies);
  }

  /**
   * A person first, if that is what the buyer wants — asked for in so many words, or a yes
   * to the assistant's offer of one. Everything else is an ordinary reply.
   */
  private async respond(
    conversation: Conversation,
    text: string,
    inboundId: string | null,
  ): Promise<OutboundMessage[]> {
    const trimmed = text.trim();
    const offered = conversation.context?.teammateOffered;

    // An offer is answered by the very next message, whatever it says. Left open, a "yes"
    // to some later question would summon a person nobody asked for.
    if (offered) {
      await this.updateContext(conversation, { teammateOffered: undefined });
    }

    // The yes first: "Yes, talk to a person" also reads as asking for one, and the offer's
    // reason tells the admin far more than "asked to speak to someone".
    if (offered && isYes(trimmed)) {
      return this.handOver(conversation, offered);
    }
    if (asksForPerson(trimmed)) {
      return this.handOver(conversation, 'The buyer asked to speak to someone');
    }
    if (offered && isNo(trimmed)) {
      return [{ text: KEEP_CHATTING }];
    }

    return this.composeReply(conversation, text, inboundId);
  }

  /** Hand over with the buyer's agreement, and tell them so plainly. */
  private async handOver(
    conversation: Conversation,
    reason: string,
  ): Promise<OutboundMessage[]> {
    if (conversation.handoverRequestedAt) {
      return [{ text: ALREADY_HANDED_OVER }];
    }
    if (await this.handover.requestHandover(conversation, reason)) {
      return [{ text: HANDED_OVER }];
    }
    return [{ text: CANNOT_HAND_OVER }];
  }

  /**
   * Ask whether the buyer would like a person, with the answers as chips. Nobody is
   * handed over until they say yes.
   */
  private async offerTeammate(
    conversation: Conversation,
    reason: string,
    question: string,
  ): Promise<OutboundMessage> {
    await this.updateContext(conversation, {
      teammateOffered: reason,
      strugglingTurns: 0,
    });
    return {
      text: question,
      payload: {
        kind: 'choices',
        data: {
          purpose: 'teammate',
          options: [
            { id: 'yes', label: OFFER_YES },
            { id: 'no', label: OFFER_NO },
          ],
        },
      },
    };
  }

  private async updateContext(
    conversation: Conversation,
    patch: Partial<Conversation['context']>,
  ): Promise<void> {
    await this.conversationService.mergeContext(conversation.id, patch);
    conversation.context = { ...conversation.context, ...patch };
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

    if (!conversational) {
      // Mid-checkout only a greeting is answered aside — "thanks" may be an answer there.
      const reply = isGreeting(trimmed)
        ? this.greetingReply(conversation)
        : conversation.state === ConversationState.DISCOVERY
          ? this.smallTalkReply(trimmed)
          : null;
      if (reply) return [{ text: reply }];
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
   * The buyer answered the add-on card. Recorded as their turn — "Add 2 × Bottled water"
   * or "No, thanks" — so the thread reads as a conversation, then the checkout carries on.
   */
  async addAddOns(
    conversation: Conversation,
    picked: { productId: string; quantity: number }[],
  ): Promise<OutboundMessage[]> {
    const { added, replies } = await this.checkoutFlow.addAddOns(
      conversation,
      picked,
    );
    // A stale card (the checkout already moved on) leaves no trace.
    if (replies.length === 0) return [];

    await this.conversationService.recordInbound({
      conversationId: conversation.id,
      text: added ? `Add ${added}` : 'No, thanks',
    });
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
      buyerFirstName: returningFirstName(conversation),
      lastDeliveryAddress: conversation.context?.lastDeliveryAddress ?? null,
      signedIn: !!conversation.accountId,
      orderReferences: conversation.context?.orderReferences ?? [],
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

    // The model is down and keyword search has nothing to say to "who are you?" — answer
    // the small talk properly rather than reporting a search that found nothing.
    const smallTalk = result.modelFailed
      ? isGreeting(text)
        ? this.greetingReply(conversation)
        : this.smallTalkReply(text)
      : null;

    const struggled = result.modelFailed || result.foundNothing;
    const repeated = repeatedThemselves(history, text);

    // The model asked for the team: at once if the buyer asked for a person, otherwise
    // by asking them first.
    if (result.handover) {
      if (result.buyerAskedForPerson) {
        return this.handOver(conversation, result.handover);
      }
      if (conversation.handoverRequestedAt) {
        return [{ text: ALREADY_HANDED_OVER }];
      }
      return [
        await this.offerTeammate(
          conversation,
          result.handover,
          OFFER_FOR_ISSUE,
        ),
      ];
    }

    // Unhelpful means the buyer did not get what they needed: a search that came back
    // empty, or the same message sent again. A model outage alone never counts — the
    // buyer still got an answer.
    const unhelpful = !smallTalk && (result.foundNothing || repeated);
    const previousStreak = conversation.context?.strugglingTurns ?? 0;
    const streak = unhelpful ? previousStreak + 1 : 0;
    if (streak !== previousStreak) {
      await this.updateContext(conversation, { strugglingTurns: streak });
    }

    await this.flagIfStruggling(conversation, struggled, repeated);

    const replies = smallTalk ? [{ text: smallTalk }] : result.messages;

    if (streak >= 2 && !conversation.handoverRequestedAt) {
      return [
        ...replies,
        await this.offerTeammate(
          conversation,
          'The assistant could not help twice in a row',
          OFFER_WHEN_STUCK,
        ),
      ];
    }

    return replies;
  }

  private greetingReply(conversation: Conversation): string {
    const name = returningFirstName(conversation);
    return name
      ? `Hi ${name}! What can I get you today?`
      : `Hello, I'm ${this.assistantName} from Recommend. What are you looking for ` +
          'today, and which area are you in?';
  }

  /** Fixed answers to small talk, for when no model is answering. Null for anything else. */
  private smallTalkReply(text: string): string | null {
    const said = text
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (/^(thank you|thanks|thank u|thx|ty)\b/.test(said)) {
      return "You're welcome! Is there anything else I can find for you?";
    }
    if (
      /\b(who are you|your name|are you (a )?(bot|robot|human|person|real))\b/.test(
        said,
      )
    ) {
      return (
        `I'm ${this.assistantName}, Recommend's virtual assistant. I help you find and ` +
        'order from vendors near you — what are you looking for?'
      );
    }
    if (/^how (are you|is it going|you dey)\b/.test(said)) {
      return "I'm doing well, thank you for asking! What can I find for you today?";
    }
    return null;
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
 * What the buyer is told about the team. Always plainly: a buyer is never handed over
 * without knowing it, and never left waiting in silence (CHATBOT_PLAN.md).
 */
const HANDED_OVER =
  "I've passed this chat to our team — someone will reply here shortly. " +
  'You can keep chatting with me meanwhile.';
const ALREADY_HANDED_OVER =
  "I've already let our team know — they'll reply here as soon as they can. " +
  'Meanwhile, I can help with anything else.';
const CANNOT_HAND_OVER =
  "I'm sorry, I can't bring the team in just now. Is there anything I can help you find?";
const OFFER_WHEN_STUCK =
  "Sorry I haven't managed to help with that. Would you like me to bring in someone from our team?";
const OFFER_FOR_ISSUE =
  'Someone from our team is best placed to help with that. Would you like me to bring them in?';
const KEEP_CHATTING = 'No problem — what would you like to try next?';
const OFFER_YES = 'Yes, talk to a person';
const OFFER_NO = 'No, keep chatting';

/**
 * The buyer asking for a person in so many words. Deliberately literal: a false positive
 * hands over someone who did not ask, which is exactly what this replaces.
 */
function asksForPerson(text: string): boolean {
  const said = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const someone =
    '(a |an |the |some |your |real )*(person|human|someone|somebody|agent|admin|staff|' +
    'team|representative|rep|manager|customer care|customer service|customer support|support)';
  return (
    new RegExp(
      `\\b(speak|talk|chat|connect me|put me through) (to|with) ${someone}\\b`,
    ).test(said) ||
    new RegExp(
      `\\b(i want|i need|i d like|can i get|get me|let me talk to) ${someone}\\b`,
    ).test(said) ||
    /^(customer care|customer service|human|agent|real person|admin)( please)?$/.test(
      said,
    )
  );
}

function isYes(text: string): boolean {
  const said = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .trim();
  return /^(yes|yeah|yea|yep|yup|sure|ok|okay|please|alright|go ahead)\b/.test(
    said,
  );
}

function isNo(text: string): boolean {
  const said = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .trim();
  return /^(no|nope|nah|not now|keep chatting|no thanks)\b/.test(said);
}

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

/**
 * A buyer who has paid before, by first name — greeted by it. Null for anyone else: a
 * name typed into an abandoned checkout is not a customer yet.
 */
function returningFirstName(conversation: Conversation): string | null {
  const name = conversation.context?.profile?.name?.trim();
  if (!conversation.context?.lastPaidAt || !name) return null;
  return name.split(/\s+/)[0];
}

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
