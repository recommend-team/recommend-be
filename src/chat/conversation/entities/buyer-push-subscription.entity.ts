import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Conversation } from './conversation.entity';

@Entity('buyer_push_subscriptions')
export class BuyerPushSubscription {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  @Index()
  conversationId!: string;

  /** Deleted with the conversation — nothing left to tell a device about. */
  @ManyToOne(() => Conversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation?: Conversation;

  /** Unique: a browser re-subscribing updates its row, and follows the conversation it is in now. */
  @Column({ type: 'varchar', unique: true })
  endpoint!: string;

  @Column({ type: 'jsonb' })
  keys!: { p256dh: string; auth: string };

  @Column({ type: 'varchar', nullable: true })
  userAgent!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
