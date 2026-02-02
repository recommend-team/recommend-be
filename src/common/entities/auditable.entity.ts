import { BaseEntity } from './base.entity';
import { Column } from 'typeorm';

export abstract class AuditableEntity extends BaseEntity {
  @Column({ type: 'uuid', nullable: true })
  createdBy: string | null;

  @Column({ type: 'uuid', nullable: true })
  updatedBy: string | null;

  @Column({ type: 'uuid', nullable: true })
  deletedBy: string | null;
}
