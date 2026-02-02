import { Entity, Column, Index, BeforeInsert, BeforeUpdate } from 'typeorm';
import { Exclude } from 'class-transformer';
import { BaseEntity } from '../../../common/entities/base.entity';
import { Role } from '../../../common/enums/roles.enum';
import { SellerStatus } from '../../../common/enums/seller-status.enum';
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

  @Column({ type: 'varchar', unique: true })
  @Index()
  phoneNumber: string;

  @Column({ type: 'enum', enum: Role, default: Role.SELLER })
  role: Role;

  @Column({ type: 'enum', enum: SellerStatus, default: SellerStatus.PENDING })
  status: SellerStatus;

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

  @Column({ type: 'boolean', default: false })
  isEmailVerified: boolean;

  @Column({ type: 'timestamp', nullable: true })
  emailVerifiedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  googleId: string | null;

  @Column({ type: 'varchar', nullable: true })
  profilePicture: string | null;

  @Column({ type: 'integer', default: 0 })
  failedLoginAttempts: number;

  @Column({ type: 'timestamp', nullable: true })
  lastLoginAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  passwordChangedAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  emailVerificationToken: string | null;

  @Column({ type: 'timestamp', nullable: true })
  emailVerificationTokenExpires: Date | null;

  @Column({ type: 'varchar', nullable: true })
  passwordResetToken: string | null;

  @Column({ type: 'timestamp', nullable: true })
  passwordResetTokenExpires: Date | null;

  @BeforeInsert()
  @BeforeUpdate()
  async hashPassword() {
    if (this.password && !this.password.startsWith('$argon2')) {
      this.password = await argon2.hash(this.password);
    }
  }

  async validatePassword(password: string): Promise<boolean> {
    if (!this.password) return false;
    return argon2.verify(this.password, password);
  }

  get fullName(): string {
    return `${this.firstName || ''} ${this.lastName || ''}`.trim();
  }

  isActive(): boolean {
    return this.status === SellerStatus.APPROVED && this.isEmailVerified;
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
