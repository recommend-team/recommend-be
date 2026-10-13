import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../auth/entities/auth.entity';
import { Checkout } from './checkout.entity';
import { OrderItem } from './order-item.entity';
import { OrderStatus } from '../../../common/enums/order-status.enum';
import { FulfillmentType } from '../../../common/enums/fulfillment-type.enum';

/**
 * One vendor's share of a checkout — their items, their money, their status.
 *
 * This stays the vendor's unit of work: everything a seller sees, and every earnings
 * figure, is computed from these rows. A basket spanning two restaurants produces two
 * of them under one `Checkout`, each owing its own vendor exactly 80% of its own
 * items, untouched by what the other vendor sold.
 */
@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  @Index()
  checkoutId!: string;

  @ManyToOne(() => Checkout, (checkout) => checkout.orders, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'checkoutId' })
  checkout!: Checkout;

  @Column({ type: 'uuid' })
  @Index()
  vendorId!: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'vendorId' })
  vendor!: User;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: ['insert'] })
  items!: OrderItem[];

  /**
   * Buyer contact, denormalised from the checkout. Not redundancy for its own sake —
   * each vendor genuinely needs to reach the buyer to fulfil their part.
   */
  @Column({ type: 'varchar' })
  buyerName!: string;

  @Column({ type: 'varchar' })
  @Index()
  buyerPhone!: string;

  @Column({ type: 'varchar', nullable: true })
  buyerEmail!: string | null;

  /**
   * This vendor's goods subtotal. Deliberately still named totalAmount: the earnings
   * query reads it, and renaming would break vendor reporting for no gain.
   * Delivery is never included here — it belongs to the platform, not the vendor.
   */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  totalAmount!: number;

  /** 20% of this vendor's subtotal. */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  platformFee!: number;

  /** 80% of this vendor's subtotal — what they are owed. */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  vendorAmount!: number;

  @Column({ type: 'enum', enum: FulfillmentType })
  fulfillmentType!: FulfillmentType;

  @Column({
    type: 'enum',
    enum: OrderStatus,
    default: OrderStatus.PENDING_PAYMENT,
  })
  status!: OrderStatus;

  @Column({ type: 'text', nullable: true })
  deliveryAddress!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
