import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  OneToMany,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Order } from './order.entity';
import { User } from '../../auth/entities/auth.entity';
import { OrderStatus } from '../../../common/enums/order-status.enum';
import { FulfillmentType } from '../../../common/enums/fulfillment-type.enum';

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

  @Column({ type: 'varchar', length: 6, nullable: true })
  deliveryCode!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByAdminId!: string | null;

  /**
   * The rider carrying this delivery, assigned by an admin until riders have an app of
   * their own. Checkout-level, like DISPATCHED: one rider carries the whole basket. Null on
   * a pickup, and on a delivery nobody has been assigned to yet.
   */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  riderId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'riderId' })
  rider?: User | null;

  /** When the current rider was assigned — reassigning resets it. */
  @Column({ type: 'timestamptz', nullable: true })
  riderAssignedAt!: Date | null;

  @OneToMany(() => Order, (order) => order.checkout)
  orders!: Order[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
