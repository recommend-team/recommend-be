import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/** Postgres returns `numeric` as a string; a rate is only ever used as a number. */
export const percentColumn = {
  to: (value: number | null) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

/**
 * A kind of thing Recommend sells — Restaurant, Beauty, Gadgets — and what Recommend
 * keeps of each sale in it.
 *
 * Admins own the list: any admin creates, renames and archives categories and edits the
 * words buyers use for them; only a Super Admin sets the percentage. Never deleted —
 * vendors and past orders point at it — only archived.
 */
@Entity('categories')
// One "Beauty", however it is capitalised.
@Index('UQ_categories_name_lower', { synchronize: false })
export class Category extends BaseEntity {
  @Column({ type: 'varchar', length: 60 })
  name!: string;

  /** Recommend's cut of each sale, in percent: 25 means 25%. */
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    transformer: percentColumn,
  })
  feePercent!: number;

  /**
   * Words buyers might use for it — "hair", "wig", "braids" — so the assistant knows
   * where to look. Lowercase. The category's own name always counts too.
   */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  keywords!: string[];

  /** Archived categories are no longer offered; their vendors keep selling, at their rate. */
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'uuid', nullable: true })
  createdByAdminId!: string | null;
}
