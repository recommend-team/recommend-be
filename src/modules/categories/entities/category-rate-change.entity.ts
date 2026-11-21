import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { percentColumn } from './category.entity';

/**
 * One change to what Recommend keeps: of a category's sales, or of one vendor's when the
 * Super Admin agrees their own rate. From what, to what, by whom, when. Written in the
 * same transaction as the change, and never edited — this is the record of who moved
 * vendors' money.
 */
@Entity('category_rate_changes')
@Index('IDX_category_rate_changes_category_created', [
  'categoryId',
  'createdAt',
])
@Index('IDX_category_rate_changes_vendor_created', ['vendorId', 'createdAt'])
export class CategoryRateChange {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  /** Set for a category's rate. */
  @Column({ type: 'uuid', nullable: true })
  categoryId!: string | null;

  /** Set for one vendor's own rate. */
  @Column({ type: 'uuid', nullable: true })
  vendorId!: string | null;

  /**
   * A category: null when it was created at this rate. A vendor: null when they had no
   * rate of their own before.
   */
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: percentColumn,
  })
  previousPercent!: number | null;

  /** A vendor: null when their own rate was removed — back to their category's. */
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: percentColumn,
  })
  newPercent!: number | null;

  /** Null when Recommend itself set it — the starting categories. */
  @Column({ type: 'uuid', nullable: true })
  changedByAdminId!: string | null;
}
