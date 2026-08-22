import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum WithdrawalStatus {
  /** Accepted and debited, not yet sent to Paystack. */
  REQUESTED = 'REQUESTED',
  /** With Paystack, or waiting for our balance to settle so it can be. */
  PROCESSING = 'PROCESSING',
  SETTLED = 'SETTLED',
  /** Given up on. The debit has been credited back. */
  FAILED = 'FAILED',
  /** Paystack sent it and then pulled it back. The debit has been credited back. */
  REVERSED = 'REVERSED',
}

@Entity('withdrawals')
@Index(['status', 'lastAttemptAt'])
export class Withdrawal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  @Index()
  userId!: string;

  @Column({ type: 'uuid' })
  accountId!: string;

  /** What leaves the wallet balance. */
  @Column({ type: 'decimal', precision: 14, scale: 2 })
  amountRequested!: number;

  /** Paystack's charge, deducted rather than absorbed so both sides drop by the same. */
  @Column({ type: 'decimal', precision: 14, scale: 2, default: 0 })
  feeAmount!: number;

  /** What the bank actually receives. */
  @Column({ type: 'decimal', precision: 14, scale: 2 })
  amountSent!: number;

  @Column({
    type: 'enum',
    enum: WithdrawalStatus,
    default: WithdrawalStatus.REQUESTED,
  })
  status!: WithdrawalStatus;

  /** Ours, and reused on every retry so Paystack cannot send twice. */
  @Column({ type: 'varchar', unique: true })
  @Index()
  reference!: string;

  /**
   * Snapshotted, so an account changed or removed mid-flight cannot redirect money that
   * is already on its way.
   */
  @Column({ type: 'varchar' })
  recipientCode!: string;

  @Column({ type: 'varchar', nullable: true })
  transferCode!: string | null;

  @Column({ type: 'text', nullable: true })
  failureReason!: string | null;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastAttemptAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  settledAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
