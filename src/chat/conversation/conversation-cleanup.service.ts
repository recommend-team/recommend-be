import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConversationService } from './conversation.service';

/**
 * Clears out chats that were opened and never used.
 *
 * Every visit creates a conversation and greets it, so without this the table grows by
 * one row per visitor, most of them a single greeting nobody answered. The admin inbox
 * already hides them; this stops them accumulating.
 */
@Injectable()
export class ConversationCleanupService {
  private readonly logger = new Logger(ConversationCleanupService.name);

  constructor(
    private readonly conversations: ConversationService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async deleteUnstarted(): Promise<number> {
    const days = this.config.get<number>('chat.unstartedRetentionDays') ?? 7;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000);

    try {
      const deleted = await this.conversations.deleteUnstarted(cutoff);
      if (deleted > 0) {
        this.logger.log(
          `Deleted ${deleted} conversation(s) older than ${days} day(s) that only ever got the greeting`,
        );
      }
      return deleted;
    } catch (error) {
      this.logger.error(
        `Could not clear unstarted conversations: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return 0;
    }
  }
}
