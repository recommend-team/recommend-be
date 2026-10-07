import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { IsNull, Repository } from 'typeorm';
import { Conversation } from '../conversation/entities/conversation.entity';
import type { MessagePayload } from '../conversation/entities/message.entity';
import { ConversationService } from '../conversation/conversation.service';
import { ChannelRegistry } from '../transport/channel.registry';
import { BuyerPushService } from './buyer-push.service';
import { OutboundMessage } from '../transport/channel.interface';
import { ConversationState } from '../enums/chat.enums';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CONVERSATION_HANDED_OVER_EVENT,
  ConversationHandedOverEvent,
  HELD_CONVERSATION_MESSAGE_EVENT,
  HeldConversationMessageEvent,
} from '../../common/events/admin-alert.events';

@Injectable()
export class HandoverService {
  private readonly logger = new Logger(HandoverService.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    private readonly conversationService: ConversationService,
    private readonly channels: ChannelRegistry,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
    private readonly buyerPush: BuyerPushService,
  ) {}

  /**
   * Tell the admin holding this conversation that the buyer has written.
   *
   * Every message, to that admin alone — they are the one the buyer is waiting on, and
   * nobody else should hear about a conversation that already has someone. Fire and
   * forget: the buyer's message is recorded whatever happens here.
   */
  announceBuyerWaiting(conversation: Conversation, text: string): void {
    if (!conversation.heldByAdminId) return;
    try {
      this.events.emit(
        HELD_CONVERSATION_MESSAGE_EVENT,
        new HeldConversationMessageEvent(
          conversation.id,
          conversation.heldByAdminId,
          text,
          conversation.context?.profile?.name ?? null,
        ),
      );
    } catch (error) {
      this.logger.error(
        `Failed to tell admin ${conversation.heldByAdminId} about a message on ${conversation.id}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  async requestHandover(
    conversation: Conversation,
    reason: string,
  ): Promise<boolean> {
    if (
      conversation.heldByAdminId ||
      conversation.handoverRequestedAt ||
      conversation.context?.unansweredHandoverAt
    ) {
      return false;
    }

    const now = new Date();
    const result = await this.conversations.update(
      {
        id: conversation.id,
        heldByAdminId: IsNull(),
        handoverRequestedAt: IsNull(),
      },
      { handoverRequestedAt: now, handoverReason: reason },
    );
    if (result.affected !== 1) return false;

    conversation.handoverRequestedAt = now;
    conversation.handoverReason = reason;

    const buyerName = conversation.context?.profile?.name ?? null;

    // Into the "needs a person" queue too, quietly — the handover sends its own alert. If
    // nobody answers in time, the flag is what keeps it in front of the admins.
    await this.conversationService.flagForAttention(
      conversation.id,
      reason,
      buyerName,
      { silent: true },
    );

    try {
      this.events.emit(
        CONVERSATION_HANDED_OVER_EVENT,
        new ConversationHandedOverEvent(
          conversation.id,
          reason,
          buyerName,
          this.waitMinutes(),
        ),
      );
    } catch (error) {
      this.logger.error(
        `Failed to announce the handover of ${conversation.id}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }

    this.logger.log(
      `Conversation ${conversation.id} handed over: ${reason.toLowerCase()}`,
    );
    return true;
  }

  async awaitingTeammate(
    conversation: Conversation,
  ): Promise<'waiting' | 'expired' | 'none'> {
    if (!conversation.handoverRequestedAt || conversation.heldByAdminId) {
      return 'none';
    }

    const waitedMinutes =
      (Date.now() - conversation.handoverRequestedAt.getTime()) / 60_000;
    if (waitedMinutes < this.waitMinutes()) return 'waiting';

    const expiredAt = new Date().toISOString();
    await this.conversations.update(
      { id: conversation.id },
      { handoverRequestedAt: null, handoverReason: null },
    );
    await this.conversationService.mergeContext(conversation.id, {
      unansweredHandoverAt: expiredAt,
    });

    conversation.handoverRequestedAt = null;
    conversation.handoverReason = null;
    conversation.context = {
      ...conversation.context,
      unansweredHandoverAt: expiredAt,
    };

    this.logger.warn(
      `Nobody took conversation ${conversation.id} within ${this.waitMinutes()} minutes — ` +
        `the assistant is answering again`,
    );
    return 'expired';
  }

  private waitMinutes(): number {
    return this.config.get<number>('chat.handoverWaitMinutes') ?? 5;
  }

  /**
   * Claim a conversation.
   *
   * Refused if someone else already holds it — two admins answering one buyer produces a
   * transcript neither of them can follow. Re-taking your own is a no-op, so a refreshed
   * browser does not lock its own user out.
   */
  async take(conversationId: string, adminId: string): Promise<Conversation> {
    const conversation = await this.load(conversationId);

    if (conversation.heldByAdminId && conversation.heldByAdminId !== adminId) {
      throw new ConflictException(
        'Another admin is already answering this conversation.',
      );
    }

    const now = new Date();
    await this.conversations.update(
      { id: conversationId },
      {
        heldByAdminId: adminId,
        heldAt: conversation.heldAt ?? now,
        lastAdminMessageAt: conversation.lastAdminMessageAt ?? now,
        // Someone came. Whatever the assistant asked for has been answered.
        handoverRequestedAt: null,
        handoverReason: null,
      },
    );

    await this.conversationService.clearAttention(conversationId);

    // A clean slate: once a person has dealt with it, the assistant may ask again later.
    if (
      conversation.context?.unansweredHandoverAt ||
      conversation.context?.strugglingTurns
    ) {
      await this.conversationService.mergeContext(conversationId, {
        unansweredHandoverAt: undefined,
        strugglingTurns: 0,
      });
    }

    this.logger.log(`Admin ${adminId} took conversation ${conversationId}`);
    return this.load(conversationId);
  }

  /**
   * Give it back to the assistant.
   */
  async release(
    conversationId: string,
    adminId: string,
  ): Promise<Conversation> {
    const conversation = await this.load(conversationId);

    if (!conversation.heldByAdminId) return conversation;

    if (conversation.heldByAdminId !== adminId) {
      throw new ConflictException(
        'That conversation is held by another admin.',
      );
    }

    await this.clearHold(conversationId, conversation.state);

    this.logger.log(
      `Admin ${adminId} released conversation ${conversationId} back to the assistant`,
    );
    return this.load(conversationId);
  }

  /** Speak to the buyer as the assistant. */
  /**
   * `payload` carries rich UI the client renders — today, a payment card. Optional, and
   * never set from a request body: an admin composes text, and the platform attaches the
   * payload for the things it generated itself, like a checkout it just created.
   */
  async send(
    conversationId: string,
    adminId: string,
    text: string,
    payload?: MessagePayload,
  ): Promise<OutboundMessage> {
    const conversation = await this.load(conversationId);

    if (conversation.heldByAdminId !== adminId) {
      throw new ConflictException(
        'Take the conversation before replying to it.',
      );
    }

    const persisted = await this.conversationService.recordOutbound({
      conversationId,
      text,
      adminId,
      payload,
    });

    await this.conversations.update(
      { id: conversationId },
      { lastAdminMessageAt: new Date() },
    );

    const outbound: OutboundMessage = {
      text,
      payload: persisted.payload ?? undefined,
      messageId: persisted.id,
      createdAt: persisted.createdAt,
    };

    await this.channels.send(
      conversation.channel,
      conversation.channelAddress,
      outbound,
    );

    // A person may answer minutes after the buyer gave up and put the phone down —
    // unlike the assistant, which only ever replies to something just said. Titled as
    // Recommend, like everything else the buyer sees from us.
    await this.buyerPush.notify(
      conversationId,
      {
        title: 'Recommend',
        body: preview(text),
        type: 'REPLY',
        url: '/',
        tag: `reply:${conversationId}`,
      },
      { ttlSeconds: 60 * 60 },
    );

    return outbound;
  }

  /** Show the buyer that someone is composing. Best-effort, like every other send. */
  async setTyping(
    conversationId: string,
    adminId: string,
    isTyping: boolean,
  ): Promise<void> {
    const conversation = await this.load(conversationId);
    if (conversation.heldByAdminId !== adminId) return;

    const adapter = this.channels.get(conversation.channel);
    adapter?.emitTyping?.(conversation.channelAddress, isTyping);
  }

  /**
   * Decide, at the moment a buyer speaks, whether the hold still stands.
   *
   * Evaluated here rather than on a timer. A schedule that releases holds would drop the
   * assistant into the middle of a live conversation because the admin was slow to type;
   * checking on inbound means the only conversations ever released are ones with somebody
   * actually waiting — and none of them wait longer than a single message.
   *
   * Returns true if the engine should stay silent.
   */
  async shouldStaySilent(conversation: Conversation): Promise<boolean> {
    if (!conversation.heldByAdminId) return false;

    const minutes =
      this.config.get<number>('chat.adminHandoverStaleMinutes') ?? 30;
    const since =
      conversation.lastAdminMessageAt ?? conversation.heldAt ?? new Date(0);
    const idleMinutes = (Date.now() - since.getTime()) / 60_000;

    if (idleMinutes < minutes) return true;

    await this.clearHold(conversation.id, conversation.state);
    conversation.heldByAdminId = null;
    conversation.state = ConversationState.DISCOVERY;

    this.logger.warn(
      `Conversation ${conversation.id} released automatically — admin silent for ` +
        `${Math.round(idleMinutes)} minutes with a buyer waiting`,
    );

    return false;
  }

  private async clearHold(
    conversationId: string,
    state: ConversationState,
  ): Promise<void> {
    await this.conversations.update(
      { id: conversationId },
      {
        heldByAdminId: null,
        heldAt: null,
        lastAdminMessageAt: null,
        // Only reset a checkout in progress. A conversation already in discovery has
        // nothing to reset, and writing the same value would be noise.
        ...(state === ConversationState.DISCOVERY
          ? {}
          : { state: ConversationState.DISCOVERY }),
      },
    );
  }

  private async load(conversationId: string): Promise<Conversation> {
    const conversation = await this.conversations.findOne({
      where: { id: conversationId },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }
}

/** A notification shows two or three lines; the rest is in the chat. */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}
