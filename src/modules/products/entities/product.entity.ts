import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  JoinTable,
  ManyToMany,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../auth/entities/auth.entity';
import { ProductChoiceGroup } from './product-choice.entity';

/** What the price is for — "₦1,000 per portion". Empty shows no unit. */
export const PRODUCT_UNITS = [
  'portion',
  'plate',
  'piece',
  'pack',
  'wrap',
  'bottle',
  'bowl',
  'cup',
] as const;
export type ProductUnit = (typeof PRODUCT_UNITS)[number];

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  vendorId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vendorId' })
  vendor!: User;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price!: number;

  @Column({ type: 'varchar', nullable: true })
  imageUrl!: string | null;

  @Column({ type: 'boolean', default: true })
  isAvailable!: boolean;

  /**
   * Sold only alongside a main item from the same vendor — drinks, extra protein. Kept out
   * of discovery, offered at checkout, refused on its own (ADDONS_PLAN.md).
   */
  @Column({ type: 'boolean', default: false })
  isAddOn!: boolean;

  @Column({ type: 'varchar', length: 16, nullable: true })
  unit!: ProductUnit | null;

  /**
   * The vendor's extras that go with this dish — ticked on the dish, from the vendor's
   * one extras list. Only on a dish (an extra has none of its own).
   */
  @ManyToMany(() => Product)
  @JoinTable({
    name: 'product_extras',
    joinColumn: { name: 'productId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'extraId', referencedColumnName: 'id' },
  })
  extras?: Product[];

  /** Questions on this dish — "Choose your protein". */
  @OneToMany(() => ProductChoiceGroup, (group) => group.product)
  choiceGroups?: ProductChoiceGroup[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
