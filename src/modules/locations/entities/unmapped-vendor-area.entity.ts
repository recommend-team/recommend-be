import {
  Entity,
  Column,
  Index,
  CreateDateColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('unmapped_vendor_areas')
export class UnmappedVendorArea {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  @Index()
  vendorId!: string;

  /** Exactly what the vendor had typed, preserved verbatim. */
  @Column({ type: 'varchar', length: 200 })
  rawValue!: string;

  @Column({ type: 'boolean', default: false })
  resolved!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
