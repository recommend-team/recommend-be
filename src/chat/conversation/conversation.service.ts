import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Brackets, IsNull, LessThan, Not, Repository } from 'typeorm';
import {
  CHAT_MESSAGE_RECORDED_EVENT,
  ChatMessageRecordedEvent,
} from '../transport/admin/admin-chat.events';
import {
  Conversation,
  ConversationContext,
} from './entities/conversation.entity';
import { ChatMessage, MessagePayload } from './entities/message.entity';
import {
  ChatChannel,
  ConversationState,
  MessageAuthor,
  MessageDirection,
} from '../enums/chat.enums';

export interface RecordInboundInput {
  conversationId: string;
  text: string;
  clientMessageId?: string;
}

/** One row of the admin queue. Never the whole transcript — that is its own request. */
export interface ConversationSummary {
  id: string;
  channel: ChatChannel;
  state: ConversationState;
  /** What the buyer told the assistant, which may be nothing yet. */
  buyerName: string | null;
  buyerPhone: string | null;
  lastMessageAt: Date | null;
  lastMessage: string | null;
  heldByAdminId: string | null;
  needsAttentionAt: Date | null;
  attentionReason: string | null;
  createdAt: Date;
}

export interface RecordOutboundInput {
  conversationId: string;
  text: string;
  payload?: MessagePayload;
  author?: MessageAuthor;
  channelMessageId?: string | null;
  /** Set when a person typed it. The author stays `ASSISTANT` either way. */
  adminId?: string | null;
}

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationsRepository: Repository<Conversation>,
    @InjectRepository(ChatMessage)
    private readonly messagesRepository: Repository<ChatMessage>,
    private readonly events: EventEmitter2,
  ) {}

  private announce(message: ChatMessage): void {
    try {
      this.events.emit(
        CHAT_MESSAGE_RECORDED_EVENT,
        new ChatMessageRecordedEvent(message),
      );
    } catch (error) {
      this.logger.warn(
        `Could not announce message ${message.id}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * One conversation per channel address. A returning device reconnects into the same
   * thread rather than starting a new one — that is the whole point of the session
   * token surviving a page reload.
   */
  async findOrCreate(
    channel: ChatChannel,
    channelAddress: string,
  ): Promise<Conversation> {
    const existing = await this.conversationsRepository.findOne({
      where: { channel, channelAddress },
    });
    if (existing) return existing;

    const conversation = this.conversationsRepository.create({
      channel,
      channelAddress,
      buyerId: null,
      areaId: null,
      state: ConversationState.DISCOVERY,
      context: {},
      lastMessageAt: null,
    });

    const saved = await this.conversationsRepository.save(conversation);
    this.logger.log(`Opened conversation ${saved.id} on ${channel}`);
    return saved;
  }

  async findById(id: string): Promise<Conversation | null> {
    return this.conversationsRepository.findOne({ where: { id } });
  }

  /**
   * Persist a buyer message. Returns null when `clientMessageId` has already been
   * seen, so a retry over a flaky connection does not duplicate the message or
   * trigger a second reply.
   */
  async recordInbound(input: RecordInboundInput): Promise<ChatMessage | null> {
    if (input.clientMessageId) {
      const duplicate = await this.messagesRepository.findOne({
        where: {
          conversationId: input.conversationId,
          clientMessageId: input.clientMessageId,
        },
      });
      if (duplicate) {
        this.logger.debug(
          `Ignored duplicate client message ${input.clientMessageId}`,
        );
        return null;
      }
    }

    const message = this.messagesRepository.create({
      conversationId: input.conversationId,
      direction: MessageDirection.INBOUND,
      author: MessageAuthor.BUYER,
      text: input.text,
      payload: null,
      channelMessageId: null,
      clientMessageId: input.clientMessageId ?? null,
    });

    const saved = await this.messagesRepository.save(message);
    await this.touch(input.conversationId);
    this.announce(saved);
    return saved;
  }

  /**
   * Persist an assistant message *before* it is handed to a channel, so a message is
   * never lost because a socket had already gone away. The client picks it up from
   * history on reconnect.
   */
  async recordOutbound(input: RecordOutboundInput): Promise<ChatMessage> {
    const message = this.messagesRepository.create({
      conversationId: input.conversationId,
      direction: MessageDirection.OUTBOUND,
      author: input.author ?? MessageAuthor.ASSISTANT,
      text: input.text,
      payload: input.payload ?? null,
      channelMessageId: input.channelMessageId ?? null,
      clientMessageId: null,
      adminId: input.adminId ?? null,
    });

    const saved = await this.messagesRepository.save(message);
    await this.touch(input.conversationId);
    this.announce(saved);
    return saved;
  }

  async flagForAttention(
    conversationId: string,
    reason: string,
  ): Promise<void> {
    await this.conversationsRepository.update(
      { id: conversationId, needsAttentionAt: IsNull() },
      { needsAttentionAt: new Date(), attentionReason: reason },
    );
  }

  /** Someone is looking at it now, so it is no longer waiting for anyone. */
  async clearAttention(conversationId: string): Promise<void> {
    await this.conversationsRepository.update(
      { id: conversationId },
      { needsAttentionAt: null, attentionReason: null },
    );
  }

  async listForAdmin(query: {
    search?: string;
    needingAttention?: boolean;
    page?: number;
    limit?: number;
  }): Promise<{
    items: ConversationSummary[];
    total: number;
    needingAttention: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(50, Math.max(1, query.limit ?? 20));

    const builder = this.conversationsRepository
      .createQueryBuilder('c')
      .orderBy('c."needsAttentionAt"', 'ASC', 'NULLS LAST')
      .addOrderBy('c."lastMessageAt"', 'DESC', 'NULLS LAST')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.needingAttention) {
      builder.andWhere('c."needsAttentionAt" IS NOT NULL');
    }

    if (query.search?.trim()) {
      const term = `%${query.search.trim().toLowerCase()}%`;
      builder.andWhere(
        new Brackets((where) =>
          where
            .where("LOWER(c.context #>> '{profile,name}') LIKE :term", { term })
            .orWhere("c.context #>> '{profile,phone}' LIKE :term", { term })
            .orWhere("LOWER(c.context #>> '{profile,email}') LIKE :term", {
              term,
            }),
        ),
      );
    }

    const [rows, total] = await builder.getManyAndCount();

    const needingAttention = await this.conversationsRepository.count({
      where: { needsAttentionAt: Not(IsNull()) },
    });

    // One query for the last message of every row on the page, rather than one per row.
    const lastMessages = await this.lastMessageFor(rows.map((row) => row.id));

    return {
      items: rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        state: row.state,
        buyerName: row.context?.profile?.name ?? null,
        buyerPhone: row.context?.profile?.phone ?? null,
        lastMessageAt: row.lastMessageAt,
        lastMessage: lastMessages.get(row.id) ?? null,
        heldByAdminId: row.heldByAdminId,
        needsAttentionAt: row.needsAttentionAt,
        attentionReason: row.attentionReason,
        createdAt: row.createdAt,
      })),
      total,
      needingAttention,
      page,
      limit,
    };
  }

  private async lastMessageFor(
    conversationIds: string[],
  ): Promise<Map<string, string>> {
    if (conversationIds.length === 0) return new Map();

    const raw: unknown = await this.messagesRepository.query(
      `SELECT DISTINCT ON ("conversationId") "conversationId" AS id, "text"
         FROM chat_messages
        WHERE "conversationId" = ANY($1)
        ORDER BY "conversationId", "createdAt" DESC`,
      [conversationIds],
    );

    const rows = raw as { id: string; text: string }[];
    return new Map(rows.map((row) => [row.id, row.text]));
  }

  /**
   * Newest-first page of history, oldest-first within the page for rendering.
   *
   * The hard ceiling of 100 guards the paginated endpoint a client calls — nobody gets
   * to ask for the whole thread in one request. It is also, in effect, the ceiling on
   * `CHAT_MAX_HISTORY_MESSAGES`: setting that higher clamps here rather than erroring,
   * so the model would quietly see 100 whatever the config claimed.
   */
  async getHistory(
    conversationId: string,
    options: { before?: Date; limit?: number } = {},
  ): Promise<ChatMessage[]> {
    const limit = Math.min(100, Math.max(1, options.limit ?? 30));

    const messages = await this.messagesRepository.find({
      where: options.before
        ? { conversationId, createdAt: LessThan(options.before) }
        : { conversationId },
      order: { createdAt: 'DESC' },
      take: limit,
    });

    return messages.reverse();
  }

  async countMessages(conversationId: string): Promise<number> {
    return this.messagesRepository.count({ where: { conversationId } });
  }

  async setState(
    conversationId: string,
    state: ConversationState,
  ): Promise<void> {
    await this.conversationsRepository.update(
      { id: conversationId },
      { state },
    );
  }

  /**
   * Find the conversation a paid checkout belongs to.
   */
  async findForCheckout(
    reference: string,
    buyerPhone: string,
  ): Promise<Conversation | null> {
    const byReference = await this.conversationsRepository
      .createQueryBuilder('c')
      .where("c.context->>'pendingPaymentReference' = :reference", {
        reference,
      })
      .orderBy('c.lastMessageAt', 'DESC', 'NULLS LAST')
      .getOne();

    if (byReference) return byReference;

    return this.conversationsRepository
      .createQueryBuilder('c')
      .where("c.context->'profile'->>'phone' = :phone", { phone: buyerPhone })
      .orderBy('c.lastMessageAt', 'DESC', 'NULLS LAST')
      .getOne();
  }

  /** Remember where the buyer is, so discovery never has to ask twice. */
  async setArea(conversationId: string, areaId: string): Promise<void> {
    await this.conversationsRepository.update(
      { id: conversationId },
      { areaId },
    );
  }

  /** Shallow-merges into the existing context rather than replacing it. */
  async mergeContext(
    conversationId: string,
    patch: ConversationContext,
  ): Promise<Conversation | null> {
    const conversation = await this.findById(conversationId);
    if (!conversation) return null;

    conversation.context = {
      ...conversation.context,
      ...patch,
      profile: { ...conversation.context?.profile, ...patch.profile },
    };

    return this.conversationsRepository.save(conversation);
  }

  private async touch(conversationId: string): Promise<void> {
    await this.conversationsRepository.update(
      { id: conversationId },
      { lastMessageAt: new Date() },
    );
  }
}
