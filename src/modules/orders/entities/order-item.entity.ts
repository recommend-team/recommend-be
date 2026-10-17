import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  Index,
  OneToMany,
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

  /**
   * Bought as an extra, at purchase time — so the kitchen packs it with the meal. Kept on
   * the line like the name and price: changing the product later does not relabel orders.
   */
  @Column({ type: 'boolean', default: false })
  isAddOn!: boolean;

  /**
   * Identical packs of this line: "Rice and beans — 2 portions, Beef ×2" **×3**.
   * `quantity` is per pack (portions on a dish, count of an extra), so the line's real
   * count is `quantity × packs`, and `lineTotal` already includes the packs. 1 for
   * anything not built as a pack.
   */
  @Column({ type: 'integer', default: 1 })
  packs!: number;

  /** The product's unit at purchase — "portion" — so the order says "2 portions". */
  @Column({ type: 'varchar', length: 16, nullable: true })
  unit!: string | null;

  /** On an extra: the dish it was added to, so the kitchen packs it with that dish. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  parentItemId!: string | null;

  /** What the buyer chose on this dish — copied, so later menu edits never change it. */
  @OneToMany(() => OrderItemChoice, (choice) => choice.orderItem, {
    eager: true,
    cascade: true,
  })
  choices?: OrderItemChoice[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

/** One answer chosen on a dish at purchase — "Protein: Fish (+₦300 per portion)". */
@Entity('order_item_choices')
export class OrderItemChoice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  orderItemId!: string;

  @ManyToOne(() => OrderItem, (item) => item.choices, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'orderItemId' })
  orderItem!: OrderItem;

  @Column({ type: 'varchar', length: 60 })
  groupName!: string;

  @Column({ type: 'varchar', length: 60 })
  optionName!: string;

  /** Per portion, at purchase time. */
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  priceDelta!: number;
}
