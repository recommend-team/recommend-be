import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Conversation } from '../conversation/entities/conversation.entity';
import { ConversationService } from '../conversation/conversation.service';
import { ChannelRegistry } from '../transport/channel.registry';
import { OutboundMessage } from '../transport/channel.interface';
import { ConversationState } from '../enums/chat.enums';

/**
 * A person answering instead of the assistant.
 *
 * The buyer is never told. Their messages are recorded as always and simply go
 * unanswered by the engine; anything the admin sends reaches them by the same path and in
 * the same shape as the bot's own replies.
 */
@Injectable()
export class HandoverService {
  private readonly logger = new Logger(HandoverService.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    private readonly conversationService: ConversationService,
    private readonly channels: ChannelRegistry,
    private readonly config: ConfigService,
  ) {}

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
      },
    );

    await this.conversationService.clearAttention(conversationId);

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
  async send(
    conversationId: string,
    adminId: string,
    text: string,
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
    });

    await this.conversations.update(
      { id: conversationId },
      { lastAdminMessageAt: new Date() },
    );

    const outbound: OutboundMessage = {
      text,
      messageId: persisted.id,
      createdAt: persisted.createdAt,
    };

    await this.channels.send(
      conversation.channel,
      conversation.channelAddress,
      outbound,
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
