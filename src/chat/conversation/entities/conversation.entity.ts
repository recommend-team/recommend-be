import { Entity, Column, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { ChatChannel, ConversationState } from '../../enums/chat.enums';
import { ChatMessage } from './message.entity';

/**
 * Contact details the assistant collects over a conversation.
 */
export interface BuyerProfileDraft {
  name?: string;
  /** Chosen during checkout; decides whether an address is needed. */
  fulfillmentType?: 'PICKUP' | 'DELIVERY';
  phone?: string;
  email?: string;
  address?: string;
}

/** A cart line as the client sent it. Quantities are trusted; prices never are. */
export interface PendingCartLine {
  productId: string;
  quantity: number;
  /** What the client last displayed. Only used to detect drift, never to price. */
  expectedUnitPrice?: number;
}

export interface ConversationContext {
  profile?: BuyerProfileDraft;
  pendingCart?: PendingCartLine[];
  lastCartSnapshot?: { itemCount: number; vendorCount: number };
  pendingCheckoutId?: string;
  pendingPaymentReference?: string;
  /**
   * Every order this device has placed, newest last.
   *
   * The buyer's order history is device-scoped because the session token *is* their
   * identity — there is no login. Keeping the references here rather than joining
   * checkouts to a conversation keeps the association on the chat side of the boundary,
   * where it belongs: the orders module stays ignorant of conversations.
   *
   * It is also what makes "this buyer may complete this order" answerable without a
   * public endpoint keyed on a reference anyone could guess.
   */
  orderReferences?: string[];
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
