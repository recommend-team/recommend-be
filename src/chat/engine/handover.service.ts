import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
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
  CONVERSATION_ASSIGNED_EVENT,
  CONVERSATION_HANDED_OVER_EVENT,
  ConversationAssignedEvent,
  ConversationHandedOverEvent,
  HELD_CONVERSATION_MESSAGE_EVENT,
  HeldConversationMessageEvent,
} from '../../common/events/admin-alert.events';
import { HandlingLogService } from './handling-log.service';
import { HandlingEndReason } from '../conversation/entities/conversation-handling.entity';
import {
  CONVERSATION_HOLDER_CHANGED_EVENT,
  ConversationHolderChangedEvent,
} from '../transport/admin/admin-chat.events';

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
    // Who answered what, for the history and the team's figures. Optional: the hold
    // itself never depends on it.
    @Optional() private readonly handlingLog?: HandlingLogService,
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

  /**
   * Put the conversation in the "waiting for you" queue. The assistant keeps answering
   * the buyer meanwhile — only an admin taking the chat quiets it.
   *
   * Only ever on the buyer's say-so: they asked for a person, or accepted the offer of one.
   */
  async requestHandover(
    conversation: Conversation,
    reason: string,
  ): Promise<boolean> {
    if (conversation.heldByAdminId || conversation.handoverRequestedAt) {
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

    // A fresh wait: the busy notice is owed again, and the struggling count is spent.
    const reset = {
      handoverNoticeSentAt: undefined,
      teammateOffered: undefined,
      strugglingTurns: 0,
    };
    await this.conversationService.mergeContext(conversation.id, reset);
    conversation.context = { ...conversation.context, ...reset };

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
          this.noticeMinutes(),
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

  /**
   * Tell each buyer whose handover nobody has taken in `CHAT_HANDOVER_NOTICE_MINUTES`
   * that the team is busy — once per handover.
   *
   * Claimed by one conditional UPDATE, so with several instances running only one of them
   * sends any given notice. The chat stays in the admin queue; this only sets expectations.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async sendBusyNotices(): Promise<number> {
    const cutoff = new Date(Date.now() - this.noticeMinutes() * 60_000);

    let claimed: Pick<Conversation, 'id' | 'channel' | 'channelAddress'>[];
    try {
      const result = await this.conversations
        .createQueryBuilder()
        .update(Conversation)
        .set({
          context: () =>
            `context || jsonb_build_object('handoverNoticeSentAt', CAST(:sentAt AS text))`,
        })
        .where('"handoverRequestedAt" <= :cutoff', { cutoff })
        .andWhere('"heldByAdminId" IS NULL')
        .andWhere('"mergedIntoId" IS NULL')
        .andWhere(`context->>'handoverNoticeSentAt' IS NULL`)
        .setParameter('sentAt', new Date().toISOString())
        .returning(['id', 'channel', 'channelAddress'])
        .execute();
      claimed = (result.raw ?? []) as typeof claimed;
    } catch (error) {
      this.logger.error(
        `Could not look for unanswered handovers: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return 0;
    }

    for (const conversation of claimed) {
      try {
        const persisted = await this.conversationService.recordOutbound({
          conversationId: conversation.id,
          text: TEAM_IS_BUSY,
        });
        await this.channels.send(
          conversation.channel,
          conversation.channelAddress,
          {
            text: TEAM_IS_BUSY,
            messageId: persisted.id,
            createdAt: persisted.createdAt,
          },
        );
        this.logger.log(
          `Nobody took conversation ${conversation.id} within ${this.noticeMinutes()} ` +
            `minutes — told the buyer the team is busy`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to send the busy notice on ${conversation.id}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    return claimed.length;
  }

  private noticeMinutes(): number {
    return this.config.get<number>('chat.handoverNoticeMinutes') ?? 3;
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
    // Read before the update below changes them: how long the buyer had been waiting,
    // and whether this is a fresh take or a refresh of their own.
    const waitingSince =
      conversation.handoverRequestedAt ?? conversation.needsAttentionAt ?? null;
    const alreadyTheirs = conversation.heldByAdminId === adminId;
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

    // A clean slate: once a person has dealt with it, the assistant may offer again later.
    const context = conversation.context;
    if (
      context?.unansweredHandoverAt ||
      context?.strugglingTurns ||
      context?.handoverNoticeSentAt ||
      context?.teammateOffered
    ) {
      await this.conversationService.mergeContext(conversationId, {
        unansweredHandoverAt: undefined,
        handoverNoticeSentAt: undefined,
        teammateOffered: undefined,
        strugglingTurns: 0,
      });
    }

    if (!alreadyTheirs) {
      await this.handlingLog?.started(conversationId, adminId, {
        waitingSince,
      });
    }

    this.logger.log(`Admin ${adminId} took conversation ${conversationId}`);
    this.announceHolder(conversationId, adminId);
    return this.load(conversationId);
  }

  /**
   * Give it back to the assistant.
   *
   * Your own, always. Someone else's only with `override` — an admin freeing a chat an
   * agent took and left, so the buyer is not stuck waiting on someone who has gone.
   */
  async release(
    conversationId: string,
    adminId: string,
    options: { override?: boolean } = {},
  ): Promise<Conversation> {
    const conversation = await this.load(conversationId);

    if (!conversation.heldByAdminId) return conversation;

    const someoneElses = conversation.heldByAdminId !== adminId;
    if (someoneElses && !options.override) {
      throw new ConflictException(
        'That conversation is held by another admin.',
      );
    }

    await this.clearHold(
      conversationId,
      conversation.state,
      someoneElses
        ? { reason: HandlingEndReason.RELEASED_BY_ADMIN, by: adminId }
        : { reason: HandlingEndReason.RELEASED },
    );

    this.logger.log(
      someoneElses
        ? `Admin ${adminId} released conversation ${conversationId} from ${conversation.heldByAdminId}`
        : `Admin ${adminId} released conversation ${conversationId} back to the assistant`,
    );
    return this.load(conversationId);
  }

  /**
   * Pass a chat someone has to a colleague — an admin's call, for a chat stuck with an
   * agent who is away or overloaded. Only a chat that is being answered: one waiting in
   * the queue is for whoever picks it up.
   *
   * The new holder is told; the buyer is not — it is all Recommend to them.
   */
  async reassign(
    conversationId: string,
    toAdminId: string,
    byAdminId: string,
  ): Promise<Conversation> {
    const conversation = await this.load(conversationId);

    if (!conversation.heldByAdminId) {
      throw new BadRequestException(
        'Nobody is answering this conversation — it is in the queue for anyone to take.',
      );
    }
    if (conversation.heldByAdminId === toAdminId) {
      throw new BadRequestException('They already have this conversation.');
    }

    const previousHolder = conversation.heldByAdminId;
    const now = new Date();
    await this.conversations.update(
      { id: conversationId },
      { heldByAdminId: toAdminId, heldAt: now, lastAdminMessageAt: now },
    );
    await this.handlingLog?.ended(
      conversationId,
      HandlingEndReason.REASSIGNED,
      byAdminId,
    );
    await this.handlingLog?.started(conversationId, toAdminId, {
      waitingSince: null,
      assignedByAdminId: byAdminId,
    });

    try {
      this.events.emit(
        CONVERSATION_ASSIGNED_EVENT,
        new ConversationAssignedEvent(
          conversationId,
          toAdminId,
          conversation.context?.profile?.name ?? null,
        ),
      );
    } catch (error) {
      this.logger.error(
        `Failed to tell ${toAdminId} about conversation ${conversationId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }

    this.logger.log(
      `Admin ${byAdminId} passed conversation ${conversationId} from ${previousHolder} to ${toAdminId}`,
    );
    this.announceHolder(conversationId, toAdminId);
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
    await this.handlingLog?.replied(conversationId, adminId);

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

    await this.clearHold(conversation.id, conversation.state, {
      reason: HandlingEndReason.IDLE,
    });
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
    ending: { reason: HandlingEndReason; by?: string },
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
    await this.handlingLog?.ended(
      conversationId,
      ending.reason,
      ending.by ?? null,
    );
    this.announceHolder(conversationId, null);
  }

  /** Tell every agent's list who has this chat now. Never fails the change itself. */
  private announceHolder(conversationId: string, adminId: string | null): void {
    try {
      this.events.emit(
        CONVERSATION_HOLDER_CHANGED_EVENT,
        new ConversationHolderChangedEvent(conversationId, adminId),
      );
    } catch (error) {
      this.logger.error(
        `Failed to announce who holds ${conversationId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  private async load(conversationId: string): Promise<Conversation> {
    const conversation = await this.conversations.findOne({
      where: { id: conversationId },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }
}

/** Sent once when a handover has waited `CHAT_HANDOVER_NOTICE_MINUTES` with nobody on it. */
export const TEAM_IS_BUSY =
  "Our team is a bit busy right now — they'll reply here as soon as they can. " +
  "Meanwhile I'm happy to keep helping.";

/** A notification shows two or three lines; the rest is in the chat. */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}
