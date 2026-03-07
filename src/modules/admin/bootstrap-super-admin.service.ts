import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../auth/entities/auth.entity';
import { Role } from '../../common/enums/roles.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';

@Injectable()
export class BootstrapSuperAdminService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapSuperAdminService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const exists = await this.usersRepo.existsBy({ role: Role.SUPER_ADMIN });
    if (exists) return;

    const email = process.env.SUPER_ADMIN_EMAIL;
    const password = process.env.SUPER_ADMIN_PASSWORD;
    const firstName = process.env.SUPER_ADMIN_FIRST_NAME ?? 'Super';
    const lastName = process.env.SUPER_ADMIN_LAST_NAME ?? 'Admin';

    if (!email || !password) {
      this.logger.warn(
        'No SUPER_ADMIN found. Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD in .env to auto-create one.',
      );
      return;
    }

    const superAdmin = this.usersRepo.create({
      firstName,
      lastName,
      email,
      password, // BeforeInsert hook hashes it
      role: Role.SUPER_ADMIN,
      status: SellerStatus.APPROVED,
      isEmailVerified: true,
    });

    await this.usersRepo.save(superAdmin);
    this.logger.log(`Super Admin created: ${email}`);
  }
}
