import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { PendingUser } from '../../modules/auth/entities/pending-user.entity';

@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);

  constructor(
    @InjectRepository(PendingUser)
    private readonly pendingUsersRepository: Repository<PendingUser>,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async cleanupExpiredPendingUsers(): Promise<void> {
    try {
      const now = new Date();

      // Find all pending users that have expired
      const expiredUsers = await this.pendingUsersRepository.find({
        where: {
          expiresAt: LessThan(now),
        },
      });

      if (expiredUsers.length === 0) {
        this.logger.debug('No expired pending users to clean up');
        return;
      }

      // Delete expired pending users
      const result = await this.pendingUsersRepository.remove(expiredUsers);

      this.logger.log(
        `Successfully cleaned up ${result.length} expired pending users`,
      );
    } catch (error) {
      this.logger.error(
        'Error during cleanup of expired pending users:',
        error,
      );
    }
  }
}
