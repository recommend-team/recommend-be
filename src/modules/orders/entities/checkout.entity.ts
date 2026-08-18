import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  OneToMany,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Order } from './order.entity';
import { OrderStatus } from '../../../common/enums/order-status.enum';
import { FulfillmentType } from '../../../common/enums/fulfillment-type.enum';

/**
 * One Paystack charge. To the customer this IS "the order" — one basket, one
 * payment, one reference — even when the basket spans several restaurants.
 *
 * Each vendor's share lives on a child `Order`, because money and status cannot be
 * held on a parent: restaurant A can be ready while B has not started, and A can be
 * refunded while B is not.
 */
@Entity('checkouts')
export class Checkout {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Paystack transaction reference. Moved here from Order — one charge, one ref. */
  @Column({ type: 'varchar', unique: true })
  @Index()
  reference!: string;

  /** Set once a BUYER user exists. Null for guest checkouts. */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  buyerId!: string | null;

  @Column({ type: 'varchar' })
  buyerName!: string;

  /** E.164. Also denormalised onto each child order so vendors can reach the buyer. */
  @Column({ type: 'varchar' })
  @Index()
  buyerPhone!: string;

  @Column({ type: 'varchar', nullable: true })
  buyerEmail!: string | null;

  @Column({ type: 'enum', enum: FulfillmentType })
  fulfillmentType!: FulfillmentType;

  @Column({ type: 'text', nullable: true })
  deliveryAddress!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  /** Sum of every vendor's subtotal. Excludes delivery. */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  goodsTotal!: number;

  /**
   * Snapshot of DELIVERY_FEE_NGN at the time of ordering, never re-read from config.
   * Raising the fee must not re-price an order that has already been placed.
   * Retained by the platform — it is not part of any vendor payout.
   */
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  deliveryFee!: number;

  /** What the buyer is actually charged: goods + delivery. */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  totalAmount!: number;

  @Column({
    type: 'enum',
    enum: OrderStatus,
    default: OrderStatus.PENDING_PAYMENT,
  })
  status!: OrderStatus;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  /**
   * Read out by the customer at the door and checked by the rider against the order they
   * are carrying — so the bag reaches the person who ordered it and not whoever answers.
   *
   * On the checkout rather than the order because one rider carries the whole basket:
   * a three-vendor purchase is still one handover, and three codes would be three ways
   * for the customer to read out the wrong one.
   *
   * Six uppercase letters, which is exactly what the column holds. Plaintext, because
   * the rider and admin both have to say it aloud. Null until dispatch, and re-minted on
   * every dispatch so a resent parcel cannot be opened with the code from the first
   * attempt.
   */
  @Column({ type: 'varchar', length: 6, nullable: true })
  deliveryCode!: string | null;

  @OneToMany(() => Order, (order) => order.checkout)
  orders!: Order[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
