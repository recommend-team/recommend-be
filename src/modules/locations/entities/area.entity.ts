import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';
import { State } from './state.entity';

/**
 * A serviceable area within a state — "Yaba", "Ikeja", "Lekki".
 *
 * This is the unit vendors pick as their coverage and buyers are matched against.
 * Admin owns the list; the application never hardcodes one.
 */
@Entity('areas')
@Unique('UQ_area_state_name', ['stateId', 'name'])
export class Area extends BaseEntity {
  @Column({ type: 'uuid' })
  @Index()
  stateId!: string;

  @ManyToOne(() => State, (state) => state.areas, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'stateId' })
  state!: State;

  @Column({ type: 'varchar', length: 100 })
  @Index()
  name!: string;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;
}
