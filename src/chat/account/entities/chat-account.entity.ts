import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A buyer who has proved an email address, so their chat can follow them to any browser.
 *
 * Deliberately not a `users` row. That table holds vendors and admins, and its emails are
 * unique — a vendor who also buys with their work address would collide with their own
 * account. Buyer `users` rows are keyed by an unverified phone and stay as they are; this
 * is only "who owns which conversation".
 */
@Entity('chat_accounts')
export class ChatAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Lower-cased and trimmed, so one person is one account however they type it. */
  @Column({ type: 'varchar', unique: true })
  email!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastSignedInAt!: Date | null;
}
