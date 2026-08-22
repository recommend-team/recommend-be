import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Who moved a status, and on whose behalf. */
export enum StatusActor {
  VENDOR = 'VENDOR',
  RIDER = 'RIDER',
  BUYER = 'BUYER',
  ADMIN = 'ADMIN',
  /** No person — the payment webhook, the reconciliation sweep. */
  SYSTEM = 'SYSTEM',
}

/**
 * One transition, recorded.
 */
@Entity('order_status_events')
export class OrderStatusEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Set for a vendor-order transition. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  orderId!: string | null;

  /** Set for a checkout-level transition — dispatch, completion. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  checkoutId!: string | null;

  @Column({ type: 'varchar' })
  fromStatus!: string;

  @Column({ type: 'varchar' })
  toStatus!: string;

  @Column({ type: 'varchar' })
  actorType!: StatusActor;

  /** Null for a buyer, who has no account, and for anything the system did alone. */
  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  /** Why — mainly for admin overrides, where the reason is the point. */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
