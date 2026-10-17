import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** What an admin did to a vendor's account. */
export enum VendorAdminAction {
  CREATED = 'CREATED',
  STORE_UPDATED = 'STORE_UPDATED',
  OWNER_UPDATED = 'OWNER_UPDATED',
  EMAIL_CHANGED = 'EMAIL_CHANGED',
  INVITE_SENT = 'INVITE_SENT',
  KYC_UPDATED = 'KYC_UPDATED',
  PRODUCT_ADDED = 'PRODUCT_ADDED',
  PRODUCT_UPDATED = 'PRODUCT_UPDATED',
  PRODUCT_REMOVED = 'PRODUCT_REMOVED',
  DEACTIVATED = 'DEACTIVATED',
}

/**
 * One change an admin made to a vendor — so "who changed this price?" has an answer, on
 * the vendor's page in the admin panel.
 *
 * `changes` holds what was sent (field → new value) — not the before-image; the summary
 * is the readable line. Kept apart from the vendor's own edits, which are not logged.
 */
@Entity('vendor_admin_edits')
@Index(['vendorId', 'createdAt'])
export class VendorAdminEdit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  vendorId!: string;

  @Column({ type: 'uuid' })
  adminId!: string;

  @Column({ type: 'varchar', length: 32 })
  action!: VendorAdminAction;

  /** For people: "Changed price, available on Jollof Rice". */
  @Column({ type: 'text' })
  summary!: string;

  @Column({ type: 'jsonb', nullable: true })
  changes!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
