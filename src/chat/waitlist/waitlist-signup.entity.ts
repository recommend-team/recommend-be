import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export type WaitlistContactKind = 'PHONE' | 'EMAIL';

/**
 * Someone who asked to be told when ordering opens, while the chat is paused.
 *
 * `conversationId` is a plain id, not a foreign key: the signup stays on the list after
 * the chat is deleted or cleared away.
 */
@Entity('waitlist_signups')
@Unique('UQ_waitlist_signups_contact', ['contact'])
export class WaitlistSignup {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_waitlist_signups',
  })
  id!: string;

  /** E.164 for a phone, lower-cased for an email — one signup per contact. */
  @Column({ type: 'varchar', length: 200 })
  contact!: string;

  @Column({ type: 'varchar', length: 10 })
  kind!: WaitlistContactKind;

  @Column({ type: 'uuid', nullable: true })
  conversationId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
