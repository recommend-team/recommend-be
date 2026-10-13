import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * What a movement of money was.
 *
 * `WITHDRAWAL` and `WITHDRAWAL_REVERSED` are declared here but written by nothing until
 * W3. They are in the type from the start because adding a value to a Postgres enum later
 * is a migration, and there is no reason to pay for one twice.
 */
export enum WalletEntryType {
  /** A vendor's goods subtotal, credited when the buyer confirms receipt. */
  EARNING = 'EARNING',
  /** Recommend's cut of that subtotal, debited alongside it. */
  COMMISSION = 'COMMISSION',
  WITHDRAWAL = 'WITHDRAWAL',
  WITHDRAWAL_REVERSED = 'WITHDRAWAL_REVERSED',
  /** Admin, with a note. The pressure valve every ledger eventually needs. */
  ADJUSTMENT = 'ADJUSTMENT',
}

/**
 * One movement of money, and the only thing a balance is ever derived from.
 *
 * Append-only: never updated, never deleted. A correction is a new row, because a ledger
 * that can be edited cannot answer "how did we get here", which is the only question it
 * exists to answer.
 *
 * Keyed on `userId` rather than `vendorId` — riders are expected to hold wallets too, and
 * a table named for one role is a table that gets copied for the next one.
 */
@Entity('wallet_entries')
export class WalletEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  @Index()
  userId!: string;

  @Column({ type: 'enum', enum: WalletEntryType })
  type!: WalletEntryType;

  /**
   * Signed: credits positive, debits negative, and the balance is their sum. Wider than
   * the `(10,2)` used on orders because an order row holds one order while this
   * accumulates a whole trading history.
   */
  @Column({ type: 'decimal', precision: 14, scale: 2 })
  amount!: number;

  /**
   * What makes crediting twice impossible rather than unlikely.
   *
   * Derived, never random — `earning:<orderId>`, `commission:<orderId>`. A replayed event
   * produces the same key and the insert is discarded by the unique index, so the number
   * of times something is delivered stops mattering.
   */
  @Column({ type: 'varchar', unique: true })
  idempotencyKey!: string;

  /** Where it came from, for a statement line that can be traced to an order. */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  orderId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  withdrawalId!: string | null;

  /** Required on an ADJUSTMENT, where the reason is the point. */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  @Index()
  createdAt!: Date;
}
