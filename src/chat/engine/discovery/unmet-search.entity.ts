import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { AlternativeKind } from './alternatives';

/**
 * Something a buyer searched for that nothing matched exactly — what people want that no
 * vendor sells yet, area by area. The list to recruit the next vendors from.
 *
 * `conversationId` and `areaId` are plain ids, not foreign keys: the demand stays on
 * record after the chat is cleared away or an area is retired.
 */
@Entity('unmet_searches')
@Index('IDX_unmet_searches_area_created', ['areaId', 'createdAt'])
export class UnmetSearch {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_unmet_searches',
  })
  id!: string;

  /** What was searched for, in the buyer's words (as the search was run). */
  @Column({ type: 'varchar', length: 200 })
  query!: string;

  /** Where the buyer is. Null when they had not said yet. */
  @Column({ type: 'uuid', nullable: true })
  areaId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  conversationId!: string | null;

  /** What was offered instead: similar items, same kind, other vendors, or nothing. */
  @Column({ type: 'varchar', length: 16 })
  alternatives!: AlternativeKind;

  @CreateDateColumn({ type: 'timestamptz' })
  @Index('IDX_unmet_searches_created')
  createdAt!: Date;
}
