import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** How a spell of someone answering a chat came to an end. */
export enum HandlingEndReason {
  /** They handed it back to the assistant themselves. */
  RELEASED = 'RELEASED',
  /** Silent too long with the buyer writing — handed back automatically. */
  IDLE = 'IDLE',
  /** An admin handed it back for them. */
  RELEASED_BY_ADMIN = 'RELEASED_BY_ADMIN',
  /** An admin passed it to a colleague. */
  REASSIGNED = 'REASSIGNED',
}

/**
 * One person answering one chat, from taking it to letting it go.
 *
 * `heldByAdminId` on the conversation says only who has it *now*; this keeps everyone who
 * ever did, so the team can see how long buyers waited for a person, how quickly each
 * agent replied, and what happened to a chat that changed hands.
 */
@Entity('conversation_handlings')
@Index('IDX_conversation_handlings_conversation_taken', [
  'conversationId',
  'takenAt',
])
@Index('IDX_conversation_handlings_admin_taken', ['adminId', 'takenAt'])
export class ConversationHandling {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'uuid' })
  conversationId!: string;

  /** The admin or customer service agent answering. */
  @Column({ type: 'uuid' })
  adminId!: string;

  /**
   * When the buyer started waiting for a person — handed over, or flagged. Null when
   * someone picked up a chat nobody had asked about.
   */
  @Column({ type: 'timestamptz', nullable: true })
  waitingSince!: Date | null;

  @Column({ type: 'timestamptz' })
  takenAt!: Date;

  /** Their first message to the buyer in this spell. Null until they write. */
  @Column({ type: 'timestamptz', nullable: true })
  firstReplyAt!: Date | null;

  /** Set when an admin passed the chat to them rather than them taking it. */
  @Column({ type: 'uuid', nullable: true })
  assignedByAdminId!: string | null;

  /** Null while they still have it. */
  @Column({ type: 'timestamptz', nullable: true })
  endedAt!: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  endReason!: HandlingEndReason | null;

  /** The admin who released or reassigned it for them, if it wasn't them. */
  @Column({ type: 'uuid', nullable: true })
  endedByAdminId!: string | null;
}
