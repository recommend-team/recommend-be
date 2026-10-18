import {
  Entity,
  Column,
  Index,
  CreateDateColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A place a buyer named that matched none of our areas or their other names — "Badore"
 * before anyone added it to Ajah. Counted, so the most asked-about come first, and kept
 * until someone says which area it is (`resolvedAreaId`), which adds it as an alias.
 */
@Entity('unplaced_locations')
export class UnplacedLocation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The latest way a buyer wrote it. */
  @Column({ type: 'varchar', length: 120 })
  text!: string;

  @Column({ type: 'varchar', length: 120, unique: true })
  normalised!: string;

  @Column({ type: 'int', default: 1 })
  timesSeen!: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  @Index('IDX_unplaced_locations_last_seen')
  lastSeenAt!: Date;

  /** Set once an admin says which area it is in. */
  @Column({ type: 'uuid', nullable: true })
  resolvedAreaId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
