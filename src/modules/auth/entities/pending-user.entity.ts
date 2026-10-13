import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';
import { Role } from '../../../common/enums/roles.enum';
import { VendorType } from '../../../common/enums/vendor-type.enum';
import { RiderType } from '../../../common/enums/rider-type.enum';

@Entity('pending_users')
export class PendingUser {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  email!: string;

  @Column({ type: 'varchar', unique: true, nullable: true })
  phoneNumber!: string | null;

  @Column({ type: 'varchar' })
  password!: string;

  @Column({ type: 'varchar' })
  firstName!: string;

  @Column({ type: 'varchar' })
  lastName!: string;

  /** The role this pending user will get upon email verification */
  @Column({ type: 'enum', enum: Role, default: Role.SELLER })
  role!: Role;

  /** Only set for pending vendors */
  @Column({ type: 'enum', enum: VendorType, nullable: true })
  vendorType!: VendorType | null;

  /** Only set for pending riders */
  @Column({ type: 'enum', enum: RiderType, nullable: true })
  riderType!: RiderType | null;

  // A vendor's business, as given at sign-up. Held here until the code is verified and
  // carried onto the account then — without it the vendor started with no name, no
  // category and no store link, and buyers could not find them.
  @Column({ type: 'varchar', nullable: true })
  businessName!: string | null;

  @Column({ type: 'varchar', nullable: true })
  businessAddress!: string | null;

  @Column({ type: 'varchar', nullable: true })
  businessCategory!: string | null;

  @Column({ type: 'text', nullable: true })
  businessDescription!: string | null;

  @Column({ type: 'varchar' })
  verificationCode!: string;

  @Column({ type: 'timestamp', nullable: true })
  verificationCodeExpiresAt!: Date;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;

  @Column({ type: 'timestamp with time zone', nullable: true })
  expiresAt!: Date;
}
