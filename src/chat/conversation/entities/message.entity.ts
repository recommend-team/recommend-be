import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { MessageAuthor, MessageDirection } from '../../enums/chat.enums';
import { Conversation } from './conversation.entity';

/**
 * Structured payload the client renders as rich UI — product cards, choice buttons,
 * a payment link. `text` always carries a plain-language fallback, so a channel with
 * no rich rendering (a WhatsApp text message, an email digest) still says something
 * coherent.
 */
export interface MessagePayload {
  kind:
    | 'text'
    | 'vendor_list'
    | 'product_list'
    | 'choices'
    | 'order_summary'
    | 'payment_link';
  data?: Record<string, unknown>;
}

@Entity('chat_messages')
export class ChatMessage extends BaseEntity {
  @Column({ type: 'uuid' })
  @Index()
  conversationId!: string;

  @ManyToOne(() => Conversation, (conversation) => conversation.messages, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'conversationId' })
  conversation!: Conversation;

  @Column({ type: 'enum', enum: MessageDirection })
  direction!: MessageDirection;

  @Column({ type: 'enum', enum: MessageAuthor })
  author!: MessageAuthor;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'jsonb', nullable: true })
  payload!: MessagePayload | null;

  /** Channel-native message id, where the channel issues one (WhatsApp does). */
  @Column({ type: 'varchar', nullable: true })
  channelMessageId!: string | null;

  /**
   * Client-supplied id for an inbound message, used to drop duplicates when a flaky
   * connection retries a send.
   */
  @Column({ type: 'varchar', nullable: true })
  @Index()
  clientMessageId!: string | null;
}
