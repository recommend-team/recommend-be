import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
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

export interface RecordOutboundInput {
  conversationId: string;
  text: string;
  payload?: MessagePayload;
  author?: MessageAuthor;
  channelMessageId?: string | null;
}

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationsRepository: Repository<Conversation>,
    @InjectRepository(ChatMessage)
    private readonly messagesRepository: Repository<ChatMessage>,
  ) {}

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
    });

    const saved = await this.messagesRepository.save(message);
    await this.touch(input.conversationId);
    return saved;
  }

  /** Newest-first page of history, oldest-first within the page for rendering. */
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
