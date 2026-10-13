import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';

export enum NotificationType {
  NEW_ORDER = 'NEW_ORDER',
  ORDER_PAID = 'ORDER_PAID',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  KYC_APPROVED = 'KYC_APPROVED',
  KYC_REJECTED = 'KYC_REJECTED',
  WALLET_CREDITED = 'WALLET_CREDITED',
  WITHDRAWAL_SETTLED = 'WITHDRAWAL_SETTLED',
  WITHDRAWAL_FAILED = 'WITHDRAWAL_FAILED',
  // An admin's feed — the alerts in `admin-alerts.service.ts`, kept for the panel's bell.
  // Prefixed: a vendor's WITHDRAWAL_FAILED and an admin's are different notifications.
  ADMIN_CONVERSATION_HANDED_OVER = 'ADMIN_CONVERSATION_HANDED_OVER',
  ADMIN_CONVERSATION_FLAGGED = 'ADMIN_CONVERSATION_FLAGGED',
  ADMIN_HELD_CONVERSATION_MESSAGE = 'ADMIN_HELD_CONVERSATION_MESSAGE',
  ADMIN_NEW_PAID_ORDER = 'ADMIN_NEW_PAID_ORDER',
  ADMIN_VENDOR_ORDER_READY = 'ADMIN_VENDOR_ORDER_READY',
  ADMIN_WITHDRAWAL_FAILED = 'ADMIN_WITHDRAWAL_FAILED',
}

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  @Index()
  userId!: string;

  @Column({ type: 'enum', enum: NotificationType })
  type!: NotificationType;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'text' })
  body!: string;

  /** Ids the dashboard needs to deep-link — orderId, checkoutId, and so on. */
  @Column({ type: 'jsonb', nullable: true })
  data!: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', nullable: true })
  readAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  @Index()
  createdAt!: Date;
}
