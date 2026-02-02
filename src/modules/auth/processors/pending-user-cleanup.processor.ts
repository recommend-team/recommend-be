import { Process, Processor } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Logger } from '@nestjs/common';
import { PendingUser } from '../entities/pending-user.entity';

@Processor('pending-user-cleanup')
export class PendingUserCleanupProcessor {
  private readonly logger = new Logger(PendingUserCleanupProcessor.name);

  constructor(
    @InjectRepository(PendingUser)
    private readonly pendingUsersRepository: Repository<PendingUser>,
  ) {}

  @Process('cleanup-expired')
  async cleanupExpiredPendingUsers(): Promise<void> {
    this.logger.log('Starting cleanup of expired pending users...');

    try {
      // Delete all pending users that have expired
      const deletedResult = await this.pendingUsersRepository.delete({
        expiresAt: LessThan(new Date()),
      });

      this.logger.log(
        `Cleaned up ${deletedResult.affected} expired pending users`,
      );
    } catch (error) {
      this.logger.error('Error cleaning up pending users:', error);
      throw error;
    }
  }
}
