import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Area } from './area.entity';

/**
 * Another name buyers use for somewhere inside an area — "Badore" and "Abraham Adesanya"
 * are in Ajah, "Chevron" and "Ikota" in Lekki. Matched as whole words in what a buyer
 * says, so they never have to know our area names.
 *
 * One name points to one area: `normalised` is unique.
 */
@Entity('area_aliases')
export class AreaAlias {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  @Index()
  areaId!: string;

  @ManyToOne(() => Area, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'areaId' })
  area!: Area;

  /** As shown: "Abraham Adesanya". */
  @Column({ type: 'varchar', length: 80 })
  name!: string;

  /** As matched: "abraham adesanya" (see `normalisePlace`). */
  @Column({ type: 'varchar', length: 80, unique: true })
  normalised!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
