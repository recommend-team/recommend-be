import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Product } from './product.entity';

/**
 * A question on one dish — "Choose your protein". Required or optional; the buyer picks
 * between `minPick` and `maxPick` options. One answer covers the whole pack (all its
 * portions get the protein chosen).
 */
@Entity('product_choice_groups')
export class ProductChoiceGroup {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  productId!: string;

  @ManyToOne(() => Product, (product) => product.choiceGroups, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'productId' })
  product!: Product;

  @Column({ type: 'varchar', length: 60 })
  name!: string;

  /** The dish can't be added until this is answered. */
  @Column({ type: 'boolean', default: false })
  required!: boolean;

  @Column({ type: 'integer', default: 0 })
  minPick!: number;

  @Column({ type: 'integer', default: 1 })
  maxPick!: number;

  @Column({ type: 'integer', default: 0 })
  position!: number;

  @OneToMany(() => ProductChoiceOption, (option) => option.group, {
    cascade: true,
  })
  options!: ProductChoiceOption[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

/** One answer to a choice — "Fish", costing ₦300 more per portion. */
@Entity('product_choice_options')
export class ProductChoiceOption {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  groupId!: string;

  @ManyToOne(() => ProductChoiceGroup, (group) => group.options, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'groupId' })
  group!: ProductChoiceGroup;

  @Column({ type: 'varchar', length: 60 })
  name!: string;

  /** Added to the dish's price per portion. ₦0 for "included". */
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  priceDelta!: number;

  /** Out of fish today: hidden from buyers, kept on the menu. */
  @Column({ type: 'boolean', default: true })
  isAvailable!: boolean;

  @Column({ type: 'integer', default: 0 })
  position!: number;
}
