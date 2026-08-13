import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum AccountStatus {
  PENDING_VERIFICATION = 'PENDING_VERIFICATION',
  ACTIVE = 'ACTIVE',
  REMOVED = 'REMOVED',
}

/**
 * A bank account money can be sent to.
 *
 * Named `accounts` rather than `vendor_payout_accounts`, and keyed on `userId`, because
 * riders are expected to hold wallets too.
 *
 * Removal is a status change, never a delete: a withdrawal from six months ago has to
 * still resolve to the account it went to.
 */
@Entity('accounts')
@Index(['userId', 'status'])
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  @Index()
  userId!: string;

  @Column({ type: 'varchar' })
  bankName!: string;

  /** Paystack's code for the bank, from their own list. */
  @Column({ type: 'varchar' })
  bankCode!: string;

  @Column({ type: 'varchar', length: 10 })
  accountNumber!: string;

  /** As Paystack resolved it, never as the user typed it. */
  @Column({ type: 'varchar' })
  accountName!: string;

  /** What a transfer is addressed to. Set when the account is verified. */
  @Column({ type: 'varchar', nullable: true })
  paystackRecipientCode!: string | null;

  @Column({
    type: 'enum',
    enum: AccountStatus,
    default: AccountStatus.PENDING_VERIFICATION,
  })
  status!: AccountStatus;

  @Column({ type: 'boolean', default: false })
  isDefault!: boolean;

  /** Hashed — a leaked database row must not be a working verification code. */
  @Column({ type: 'varchar', nullable: true })
  verificationCodeHash!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  verificationExpiresAt!: Date | null;

  @Column({ type: 'integer', default: 0 })
  verificationAttempts!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastCodeSentAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  removedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
