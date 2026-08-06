import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../auth/entities/auth.entity';
import { Product } from '../../products/entities/product.entity';
import { OrderStatus } from '../../../common/enums/order-status.enum';
import { FulfillmentType } from '../../../common/enums/fulfillment-type.enum';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  productId!: string;

  @ManyToOne(() => Product)
  @JoinColumn({ name: 'productId' })
  product!: Product;

  @Column({ type: 'uuid' })
  vendorId!: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'vendorId' })
  vendor!: User;

  @Column({ type: 'varchar' })
  buyerPhone!: string;

  @Column({ type: 'varchar' })
  buyerName!: string;

  @Column({ type: 'varchar', nullable: true })
  buyerEmail!: string | null;

  @Column({ type: 'integer' })
  quantity!: number;

  /** Price at time of order (snapshot) */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  unitPrice!: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  totalAmount!: number;

  /** 20% platform fee */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  platformFee!: number;

  /** 80% vendor payout */
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

  /** Paystack transaction reference */
  @Column({ type: 'varchar', unique: true, nullable: true })
  paymentReference!: string | null;

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
