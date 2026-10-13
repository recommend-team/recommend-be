import { Entity, Column, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Area } from './area.entity';

/**
 * A state the platform operates in — created and maintained by admin, never hardcoded.
 */
@Entity('states')
export class State extends BaseEntity {
  @Column({ type: 'varchar', length: 100, unique: true })
  @Index()
  name!: string;

  /** Optional short code, e.g. "LA" for Lagos. */
  @Column({ type: 'varchar', length: 10, nullable: true, unique: true })
  code!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @OneToMany(() => Area, (area) => area.state)
  areas!: Area[];
}
