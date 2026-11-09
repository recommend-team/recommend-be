import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Brackets, In, IsNull, LessThan, Repository } from 'typeorm';
import {
  CHAT_MESSAGE_RECORDED_EVENT,
  ChatMessageRecordedEvent,
} from '../transport/admin/admin-chat.events';
import {
  CONVERSATION_NEEDS_ATTENTION_EVENT,
  ConversationNeedsAttentionEvent,
} from '../../common/events/admin-alert.events';
import {
  Conversation,
  ConversationContext,
} from './entities/conversation.entity';
import { ChatMessage, MessagePayload } from './entities/message.entity';
import { ChatAccount } from '../account/entities/chat-account.entity';
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
  /** The email the buyer proved with a code, if they signed in. Unlike a typed one, it is theirs. */
  verifiedEmail: string | null;
  lastMessageAt: Date | null;
  lastMessage: string | null;
  heldByAdminId: string | null;
  needsAttentionAt: Date | null;
  attentionReason: string | null;
  handoverRequestedAt: Date | null;
  handoverReason: string | null;
  createdAt: Date;
  /** Set only in the deleted list. */
  deletedAt: Date | null;
}

/** Why a conversation was not deleted, in words an admin can act on. */
export const HAS_ORDERS =
  "This chat has orders, so it can't be deleted — the buyer needs it to see and confirm them.";

/**
 * A conversation the buyer has started: they have sent at least one message.
 *
 * Opening the chat creates a conversation and greets it, so most of them are visits
 * nobody followed up — the buyer typing, or tapping a suggestion, is what makes one real.
 */
function buyerHasSpoken(conversation: string): string {
  return `EXISTS (
    SELECT 1 FROM chat_messages m
    WHERE m."conversationId" = ${conversation}.id
      AND m.direction = '${MessageDirection.INBOUND}'
  )`;
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

  /** For admins only: a deleted conversation can still be read before restoring it. */
  async findByIdIncludingDeleted(id: string): Promise<Conversation | null> {
    return this.conversationsRepository.findOne({
      where: { id },
      withDeleted: true,
    });
  }

  /**
   * The conversation this one now lives in. Itself, unless it was folded into a
   * signed-in buyer's thread — then wherever that went. Bounded, so a bad pointer
   * cannot loop.
   */
  async resolveLive(conversation: Conversation): Promise<Conversation> {
    let current = conversation;
    for (let hop = 0; hop < 5 && current.mergedIntoId; hop++) {
      const next = await this.findById(current.mergedIntoId);
      if (!next) break;
      current = next;
    }
    return current;
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
    buyerName: string | null = null,
    options: { silent?: boolean } = {},
  ): Promise<void> {
    const result = await this.conversationsRepository.update(
      { id: conversationId, needsAttentionAt: IsNull() },
      { needsAttentionAt: new Date(), attentionReason: reason },
    );

    // Only when this call raised the flag. One already up has been announced, and
    // repeating it on every struggling turn would teach admins to ignore it.
    if (result.affected === 1 && !options.silent) {
      try {
        this.events.emit(
          CONVERSATION_NEEDS_ATTENTION_EVENT,
          new ConversationNeedsAttentionEvent(
            conversationId,
            reason,
            buyerName,
          ),
        );
      } catch (error) {
        this.logger.error(
          `Failed to announce attention on ${conversationId}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
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
    /** The deleted ones instead, most recently deleted first. */
    deleted?: boolean;
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

    // Newest activity first, like any inbox. Conversations waiting for a person are not
    // pinned above it: a flag left from weeks ago buried today's chats. They stay easy to
    // find through their badge and the needing-attention filter.
    const builder = this.conversationsRepository
      .createQueryBuilder('c')
      // One folded into a signed-in buyer's thread lives on there, not as a duplicate.
      .where('c."mergedIntoId" IS NULL')
      // A visit that only got the greeting is not a conversation yet.
      .andWhere(buyerHasSpoken('c'))
      .skip((page - 1) * limit)
      .take(limit);

    if (query.deleted) {
      builder
        .withDeleted()
        .andWhere('c."deletedAt" IS NOT NULL')
        .orderBy('c."deletedAt"', 'DESC');
    } else {
      builder
        .orderBy('c."lastMessageAt"', 'DESC', 'NULLS LAST')
        .addOrderBy('c."createdAt"', 'DESC');
    }

    if (query.needingAttention) {
      builder.andWhere(
        '(c."needsAttentionAt" IS NOT NULL OR c."handoverRequestedAt" IS NOT NULL)',
      );
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

    // Counted by the same rule as the list, so the badge never promises a chat the
    // list does not show.
    const needingAttention = await this.conversationsRepository
      .createQueryBuilder('c')
      .where('c."mergedIntoId" IS NULL')
      .andWhere(
        '(c."needsAttentionAt" IS NOT NULL OR c."handoverRequestedAt" IS NOT NULL)',
      )
      .andWhere(buyerHasSpoken('c'))
      .getCount();

    // One query for the last message of every row on the page, rather than one per row.
    const lastMessages = await this.lastMessageFor(rows.map((row) => row.id));
    const emails = await this.verifiedEmails(rows);

    return {
      items: rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        state: row.state,
        buyerName: row.context?.profile?.name ?? null,
        buyerPhone: row.context?.profile?.phone ?? null,
        verifiedEmail: row.accountId
          ? (emails.get(row.accountId) ?? null)
          : null,
        lastMessageAt: row.lastMessageAt,
        lastMessage: lastMessages.get(row.id) ?? null,
        heldByAdminId: row.heldByAdminId,
        needsAttentionAt: row.needsAttentionAt,
        attentionReason: row.attentionReason,
        handoverRequestedAt: row.handoverRequestedAt,
        handoverReason: row.handoverReason,
        createdAt: row.createdAt,
        deletedAt: row.deletedAt ?? null,
      })),
      total,
      needingAttention,
      page,
      limit,
    };
  }

  /**
   * An admin deletes conversations — soft, so they can be brought back. Gone from the
   * inbox; a buyer coming back on that device starts a fresh chat.
   *
   * Never one with orders, or a payment waiting: the buyer's Orders tab reads them from
   * here, and confirming receipt — which pays the vendor — goes through it. Each refused
   * one says why. Any older threads folded into a deleted one go with it, so their
   * devices start fresh too rather than following a pointer to nothing.
   */
  async deleteForAdmin(
    ids: string[],
    adminId: string,
  ): Promise<{ deleted: string[]; refused: { id: string; reason: string }[] }> {
    const unique = [...new Set(ids)];
    const rows = await this.conversationsRepository.find({
      where: { id: In(unique), mergedIntoId: IsNull() },
    });
    const found = new Map(rows.map((row) => [row.id, row]));

    const deleted: string[] = [];
    const refused: { id: string; reason: string }[] = [];
    for (const id of unique) {
      const row = found.get(id);
      if (!row) {
        refused.push({ id, reason: 'Conversation not found' });
      } else if (hasOrders(row)) {
        refused.push({ id, reason: HAS_ORDERS });
      } else {
        deleted.push(id);
      }
    }

    if (deleted.length > 0) {
      await this.conversationsRepository
        .createQueryBuilder()
        .update(Conversation)
        .set({ deletedAt: () => 'now()', deletedByAdminId: adminId })
        .where('("id" IN (:...ids) OR "mergedIntoId" IN (:...ids))', {
          ids: deleted,
        })
        .execute();
      this.logger.log(
        `Admin ${adminId} deleted ${deleted.length} conversation(s)`,
      );
    }
    return { deleted, refused };
  }

  /**
   * Brings a deleted conversation back, with any threads deleted along with it. Refused
   * when the buyer has started a new chat since — two live threads for one device, or
   * one account, is what the unique indexes forbid.
   */
  async restoreForAdmin(id: string): Promise<void> {
    const row = await this.conversationsRepository.findOne({
      where: { id },
      withDeleted: true,
    });
    if (!row?.deletedAt)
      throw new NotFoundException('Deleted conversation not found');

    if (await this.replacedSince(row)) {
      throw new ConflictException(
        "This buyer has started a new chat since, so this one can't be brought back.",
      );
    }

    // Folded-in threads come back too, unless that device has moved on.
    const folded = await this.conversationsRepository.find({
      where: { mergedIntoId: id },
      withDeleted: true,
    });
    const back = [id];
    for (const thread of folded) {
      if (thread.deletedAt && !(await this.replacedSince(thread))) {
        back.push(thread.id);
      }
    }

    await this.conversationsRepository
      .createQueryBuilder()
      .update(Conversation)
      .set({ deletedAt: null, deletedByAdminId: null })
      .where('"id" IN (:...ids)', { ids: back })
      .execute();
  }

  /** Whether a live conversation has taken this deleted one's device or account. */
  private async replacedSince(row: Conversation): Promise<boolean> {
    const device = await this.conversationsRepository.count({
      where: { channel: row.channel, channelAddress: row.channelAddress },
    });
    if (device > 0) return true;
    if (!row.accountId || row.mergedIntoId) return false;
    const account = await this.conversationsRepository.count({
      where: { accountId: row.accountId, mergedIntoId: IsNull() },
    });
    return account > 0;
  }

  /**
   * Delete visits that never became conversations: opened, greeted, and left.
   *
   * Only ones nothing else depends on. A signed-in browser's (`accountId`) or a folded one
   * (`mergedIntoId`) is how that browser finds its way back to the buyer's thread, so it
   * stays even if the buyer never typed on it. Messages and push subscriptions go with
   * the row (ON DELETE CASCADE). A buyer returning afterwards is simply greeted again.
   */
  async deleteUnstarted(createdBefore: Date): Promise<number> {
    const result = await this.conversationsRepository
      .createQueryBuilder()
      .delete()
      .from(Conversation)
      .where('"createdAt" < :createdBefore', { createdBefore })
      .andWhere('"accountId" IS NULL')
      .andWhere('"mergedIntoId" IS NULL')
      .andWhere('"heldByAdminId" IS NULL')
      .andWhere('"needsAttentionAt" IS NULL')
      .andWhere('"handoverRequestedAt" IS NULL')
      // No alias on a DELETE, so the condition names the table itself.
      .andWhere(`NOT ${buyerHasSpoken('conversations')}`)
      .execute();
    return result.affected ?? 0;
  }

  /** The verified email of each signed-in conversation, in one query. */
  async verifiedEmails(
    conversations: Pick<Conversation, 'accountId'>[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        conversations
          .map((conversation) => conversation.accountId)
          .filter((id): id is string => !!id),
      ),
    ];
    if (ids.length === 0) return new Map();

    const accounts = await this.conversationsRepository.manager.find(
      ChatAccount,
      { where: { id: In(ids) } },
    );
    return new Map(accounts.map((account) => [account.id, account.email]));
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
   *
   * First the one that holds the order — what the Orders tab lists and where "I've
   * received it" works. Then one waiting on its payment. Last, by the buyer's phone,
   * which is a guess: several chats can carry one number.
   */
  async findForCheckout(
    reference: string,
    buyerPhone: string,
  ): Promise<Conversation | null> {
    // Only live conversations: one folded into a signed-in buyer's thread handed its
    // orders, payment and phone over, and the update belongs where the buyer now reads.
    const holdingIt = await this.conversationsRepository
      .createQueryBuilder('c')
      .where(
        "jsonb_exists(COALESCE(c.context->'orderReferences', '[]'::jsonb), :reference)",
        { reference },
      )
      .andWhere('c."mergedIntoId" IS NULL')
      .orderBy('c.lastMessageAt', 'DESC', 'NULLS LAST')
      .getOne();

    if (holdingIt) return holdingIt;

    const byReference = await this.conversationsRepository
      .createQueryBuilder('c')
      .where("c.context->>'pendingPaymentReference' = :reference", {
        reference,
      })
      .andWhere('c."mergedIntoId" IS NULL')
      .orderBy('c.lastMessageAt', 'DESC', 'NULLS LAST')
      .getOne();

    if (byReference) return byReference;

    return this.conversationsRepository
      .createQueryBuilder('c')
      .where("c.context->'profile'->>'phone' = :phone", { phone: buyerPhone })
      .andWhere('c."mergedIntoId" IS NULL')
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

/** Orders placed from it, or a payment waiting — the buyer still needs this thread. */
function hasOrders(conversation: Conversation): boolean {
  const context = conversation.context ?? {};
  return (
    (context.orderReferences?.length ?? 0) > 0 ||
    !!context.pendingPaymentReference ||
    !!context.pendingCheckoutId
  );
}
