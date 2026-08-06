import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { Order } from './order.entity';
import { Product } from '../../products/entities/product.entity';

/**
 * A line on a vendor's order.
 *
 * `productName` and `unitPrice` are snapshots taken at purchase time. The product
 * they point at can be renamed, re-priced or deleted afterwards, and this row must
 * still say what the buyer actually bought and what they actually paid.
 */
@Entity('order_items')
export class OrderItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  @Index()
  orderId!: string;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'orderId' })
  order!: Order;

  @Column({ type: 'uuid' })
  productId!: string;

  /** Kept as SET NULL so deleting a product never destroys order history. */
  @ManyToOne(() => Product, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'productId' })
  product!: Product | null;

  /** Name at purchase time. */
  @Column({ type: 'varchar', length: 100 })
  productName!: string;

  /** Price at purchase time. */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  unitPrice!: number;

  @Column({ type: 'integer' })
  quantity!: number;

  /** unitPrice × quantity, stored so totals never depend on re-multiplying. */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  lineTotal!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
