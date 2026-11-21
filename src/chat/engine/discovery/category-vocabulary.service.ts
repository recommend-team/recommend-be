import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CATEGORIES_CHANGED_EVENT } from '../../../common/events/categories.events';
import {
  VOCABULARY_PORT,
  type VocabularyPort,
} from '../../ports/vocabulary.port';
import { useCategoryWords } from './synonyms';

/**
 * Keeps the assistant's categories, and the words that point at them, in step with what
 * admins have set: at startup, the moment an admin changes one on this instance, and
 * every few minutes for changes made on another.
 *
 * If the database can't be read, the assistant carries on with what it last knew — at
 * worst, the categories Recommend started with.
 */
@Injectable()
export class CategoryVocabularyService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CategoryVocabularyService.name);

  constructor(
    @Inject(VOCABULARY_PORT) private readonly vocabulary: VocabularyPort,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.refresh();
  }

  @OnEvent(CATEGORIES_CHANGED_EVENT, { async: true })
  async onChanged(): Promise<void> {
    await this.refresh();
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async refresh(): Promise<void> {
    try {
      useCategoryWords(await this.vocabulary.activeCategories());
    } catch (error) {
      this.logger.warn(
        `Couldn't reload categories; keeping the current ones: ${(error as Error).message}`,
      );
    }
  }
}
