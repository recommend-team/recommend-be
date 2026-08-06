import { Entity, Column, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { ChatChannel, ConversationState } from '../../enums/chat.enums';
import { ChatMessage } from './message.entity';

/**
 * Contact details the assistant collects over a conversation.
 */
export interface BuyerProfileDraft {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
}

export interface ConversationContext {
  profile?: BuyerProfileDraft;
  /**
   * The cart lives in the client's localStorage, not here. When the buyer sends a
   * message the client may attach a snapshot so the assistant can talk about the
   * basket — it is display context only and never influences pricing.
   */
  lastCartSnapshot?: { itemCount: number; vendorCount: number };
  /** Set once a checkout exists, so the payment webhook can find its way back here. */
  pendingCheckoutId?: string;
  pendingPaymentReference?: string;
}

@Entity('conversations')
export class Conversation extends BaseEntity {
  @Column({ type: 'enum', enum: ChatChannel })
  @Index()
  channel!: ChatChannel;

  /**
   * Channel-native address. PWA → the session id issued to the device.
   * WhatsApp → the E.164 number.
   */
  @Column({ type: 'varchar' })
  @Index()
  channelAddress!: string;

  /** Set at checkout, once a BUYER user has been minted. Null while anonymous. */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  buyerId!: string | null;

  /** Resolved from what the buyer says about where they are. Drives area matching. */
  @Column({ type: 'uuid', nullable: true })
  areaId!: string | null;

  @Column({
    type: 'enum',
    enum: ConversationState,
    default: ConversationState.DISCOVERY,
  })
  state!: ConversationState;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  context!: ConversationContext;

  @Column({ type: 'timestamptz', nullable: true })
  lastMessageAt!: Date | null;

  @OneToMany(() => ChatMessage, (message) => message.conversation)
  messages!: ChatMessage[];
}
