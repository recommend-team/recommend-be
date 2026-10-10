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
  orderReferences?: string[];
  strugglingTurns?: number;
  /** Retired: a handover no longer expires. Still cleared, for conversations that have it. */
  unansweredHandoverAt?: string;
  /**
   * The assistant offered a person and is waiting for the buyer's yes or no — why it
   * offered, which becomes the handover reason if they accept.
   */
  teammateOffered?: string;
  /** The buyer was told the team is busy — once per handover. */
  handoverNoticeSentAt?: string;
  /** The buyer skipped the receipt-email step. Remembered, so a later order does not ask again. */
  receiptEmailSkipped?: boolean;
  /**
   * When this buyer last paid. Set only by a confirmed payment: a returning buyer is one
   * who has bought, not one who got as far as typing their details.
   */
  lastPaidAt?: string;
  /**
   * Where their most recent paid delivery went — offered back at the next checkout.
   * Never an address typed for an order that was then abandoned.
   */
  lastDeliveryAddress?: string;
  /** Add-ons were offered for the cart now being checked out — never offered twice. */
  addOnsOffered?: boolean;
  /**
   * A delivery address being taken in steps, all within COLLECTING_ADDRESS: the buyer
   * is asked which area it is in (AREA), then for a landmark (LANDMARK). `text` is the
   * address so far; `suggestedAreaId` is the area offered for a yes.
   */
  addressDraft?: {
    text: string;
    stage: 'AREA' | 'LANDMARK';
    suggestedAreaId?: string;
  };
  /** The buyer was asked once to add a house number and street — never twice. */
  addressRetried?: boolean;
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

  /**
   * The verified email this conversation belongs to, once the buyer has signed in. Any
   * browser that signs in with that email joins this conversation. At most one live
   * conversation per account — a partial unique index enforces it.
   */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  accountId!: string | null;

  /**
   * Set when this conversation was folded into the account's own on sign-in. Its
   * messages, orders and devices moved there; anything still holding this conversation
   * (an old token, an admin link) follows the pointer.
   */
  @Column({ type: 'uuid', nullable: true })
  mergedIntoId!: string | null;

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

  // ─── Human takeover ─────────────────────────────────────────────────────────

  /**
   * The admin currently answering, if any. While set, the engine records inbound
   * messages and replies to none of them.
   */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  heldByAdminId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  heldAt!: Date | null;

  /**
   * When the admin last said something. Staleness is measured from here, not from
   * `heldAt` — an admin mid-conversation has not abandoned it.
   */
  @Column({ type: 'timestamptz', nullable: true })
  lastAdminMessageAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  @Index()
  needsAttentionAt!: Date | null;
  @Column({ type: 'varchar', nullable: true })
  attentionReason!: string | null;
  @Column({ type: 'timestamptz', nullable: true })
  handoverRequestedAt!: Date | null;

  @Column({ type: 'varchar', nullable: true })
  handoverReason!: string | null;

  @OneToMany(() => ChatMessage, (message) => message.conversation)
  messages!: ChatMessage[];

  /** Whether a person is answering this conversation right now. */
  isHeld(): boolean {
    return this.heldByAdminId !== null;
  }
}
