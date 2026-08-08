import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
  Unique,
  CreateDateColumn,
} from 'typeorm';

/**
 * A browser's Web Push endpoint, as handed over by the Push API.
 */
@Entity('push_subscriptions')
@Unique('UQ_push_endpoint', ['endpoint'])
export class PushSubscription {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  @Index()
  userId!: string;

  @Column({ type: 'text' })
  endpoint!: string;

  /** `p256dh` and `auth` from the browser's subscription. */
  @Column({ type: 'jsonb' })
  keys!: { p256dh: string; auth: string };

  @Column({ type: 'varchar', nullable: true })
  userAgent!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
