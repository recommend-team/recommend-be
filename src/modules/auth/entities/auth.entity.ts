import { Entity, Column, Index, BeforeInsert, BeforeUpdate } from 'typeorm';
import { Exclude } from 'class-transformer';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Role } from '../../../common/enums/roles.enum';
import { SellerStatus } from '../../../common/enums/seller-status.enum';
import { VendorType } from '../../../common/enums/vendor-type.enum';
import { RiderType } from '../../../common/enums/rider-type.enum';
import * as argon2 from 'argon2';

@Entity('users')
export class User extends BaseEntity {
  @Column({ type: 'varchar', unique: true })
  @Index()
  email: string;

  @Column({ type: 'varchar', nullable: true })
  @Exclude()
  password: string | null;

  @Column({ type: 'varchar' })
  firstName: string;

  @Column({ type: 'varchar' })
  lastName: string;

  /** Phone is required for vendors/riders; buyers may omit (WhatsApp handles identity) */
  @Column({ type: 'varchar', unique: true, nullable: true })
  @Index()
  phoneNumber: string | null;

  @Column({ type: 'enum', enum: Role, default: Role.SELLER })
  role: Role;

  @Column({ type: 'enum', enum: SellerStatus, default: SellerStatus.PENDING })
  status: SellerStatus;

  // ─── Vendor-specific ───────────────────────────────────────────────────────

  @Column({ type: 'enum', enum: VendorType, nullable: true })
  vendorType: VendorType | null;

  /** Unique URL slug for the public storefront. Auto-generated from businessName on first set. */
  @Column({ type: 'varchar', unique: true, nullable: true })
  @Index()
  slug: string | null;

  @Column({ type: 'varchar', nullable: true })
  businessName: string | null;

  @Column({ type: 'varchar', nullable: true })
  businessAddress: string | null;

  @Column({ type: 'text', nullable: true })
  businessDescription: string | null;

  @Column({ type: 'varchar', nullable: true })
  businessCategory: string | null;

  @Column({ nullable: true, array: true, type: 'text' })
  businessAreas: string[] | null;

  /** null = unlimited (registered vendors). 20 for non-registered vendors. */
  @Column({ type: 'integer', nullable: true })
  orderQuota: number | null;

  @Column({ type: 'integer', default: 0 })
  monthlyOrderCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastOrderCountReset: Date | null;

  // ─── Rider-specific ────────────────────────────────────────────────────────

  @Column({ type: 'enum', enum: RiderType, nullable: true })
  riderType: RiderType | null;

  // ─── KYC: Registered vendor ────────────────────────────────────────────────

  @Column({ type: 'varchar', nullable: true })
  cacDocumentUrl: string | null;

  @Column({ type: 'varchar', nullable: true })
  tinDocumentUrl: string | null;

  // ─── KYC: Non-registered vendor ────────────────────────────────────────────

  @Column({ type: 'varchar', nullable: true })
  ninDocumentUrl: string | null;

  @Column({ type: 'varchar', nullable: true })
  passportPhotoUrl: string | null;

  @Column({ type: 'varchar', nullable: true })
  bankStatementUrl: string | null;

  @Column({ type: 'varchar', nullable: true })
  utilityBillUrl: string | null;

  // ─── KYC: Rider ────────────────────────────────────────────────────────────

  @Column({ type: 'varchar', nullable: true })
  governmentIdUrl: string | null;

  @Column({ type: 'varchar', nullable: true })
  selfieUrl: string | null;

  /** Bank Verification Number */
  @Column({ type: 'varchar', nullable: true })
  bvn: string | null;

  @Column({ type: 'varchar', nullable: true })
  guarantorName: string | null;

  @Column({ type: 'varchar', nullable: true })
  guarantorPhone: string | null;

  // ─── Vendor: storefront visuals ────────────────────────────────────────────

  @Column({ type: 'varchar', nullable: true })
  businessLogoUrl: string | null;

  @Column({ type: 'varchar', nullable: true })
  businessBannerUrl: string | null;

  /** WhatsApp number for order notifications (may differ from phoneNumber) */
  @Column({ type: 'varchar', nullable: true })
  whatsappNumber: string | null;

  /** Whether the vendor is currently accepting orders */
  @Column({ type: 'boolean', default: false })
  isOpen: boolean;

  /**
   * Per-day schedule: { monday: { isOpen, open: "HH:mm", close: "HH:mm" }, ... }
   */
  @Column({ type: 'jsonb', nullable: true })
  operatingHours: Record<
    string,
    { isOpen: boolean; open: string; close: string }
  > | null;

  // ─── Vendor: payout / bank details ─────────────────────────────────────────

  @Column({ type: 'varchar', nullable: true })
  bankName: string | null;

  /** Paystack bank code */
  @Column({ type: 'varchar', nullable: true })
  bankCode: string | null;

  /** 10-digit NUBAN account number */
  @Column({ type: 'varchar', nullable: true })
  bankAccountNumber: string | null;

  /** Account name as verified with bank */
  @Column({ type: 'varchar', nullable: true })
  bankAccountName: string | null;

  // ─── Auth / session ────────────────────────────────────────────────────────

  @Column({ type: 'boolean', default: false })
  isEmailVerified: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  emailVerifiedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  googleId: string | null;

  @Column({ type: 'varchar', nullable: true })
  profilePicture: string | null;

  @Column({ type: 'integer', default: 0 })
  failedLoginAttempts: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  passwordChangedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  @Exclude()
  emailVerificationToken: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  emailVerificationTokenExpires: Date | null;

  @Column({ type: 'varchar', nullable: true })
  @Exclude()
  passwordResetToken: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  passwordResetTokenExpires: Date | null;

  // ─── Hooks ─────────────────────────────────────────────────────────────────

  @BeforeInsert()
  @BeforeUpdate()
  async hashPassword() {
    if (this.password && !this.password.startsWith('$argon2')) {
      this.password = await argon2.hash(this.password);
    }
  }

  // ─── Methods ───────────────────────────────────────────────────────────────

  async validatePassword(password: string): Promise<boolean> {
    if (!this.password) return false;
    return argon2.verify(this.password, password);
  }

  get fullName(): string {
    return `${this.firstName || ''} ${this.lastName || ''}`.trim();
  }

  /**
   * Buyers are active once their record exists (status APPROVED).
   * Vendors and Riders are active once their email is verified — they may
   * log in and access their dashboard while KYC is PENDING. Approval is
   * enforced at sensitive endpoints (e.g. creating products, picking orders),
   * not at session level.
   */
  isActive(): boolean {
    if (this.role === Role.BUYER) {
      return this.status === SellerStatus.APPROVED;
    }
    if (
      this.status === SellerStatus.SUSPENDED ||
      this.status === SellerStatus.DEACTIVATED
    ) {
      return false;
    }
    return this.isEmailVerified;
  }

  isApproved(): boolean {
    return this.status === SellerStatus.APPROVED;
  }

  isPendingApproval(): boolean {
    return this.status === SellerStatus.PENDING && this.isEmailVerified;
  }

  canLogin(): boolean {
    return this.isActive() && this.failedLoginAttempts < 5;
  }

  recordFailedLogin(): void {
    this.failedLoginAttempts += 1;
  }

  recordSuccessfulLogin(): void {
    this.failedLoginAttempts = 0;
    this.lastLoginAt = new Date();
  }
}
