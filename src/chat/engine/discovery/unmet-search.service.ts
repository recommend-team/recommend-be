import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UnmetSearch } from './unmet-search.entity';
import type { UnmetSearchDraft } from './tools';

/** Long enough for any real search, short enough that pasted text cannot fill the table. */
const QUERY_LIMIT = 200;

/**
 * Records searches nothing matched exactly. Best effort: a failure here is logged and
 * swallowed — the buyer already has their answer, and a missed row costs nothing.
 */
@Injectable()
export class UnmetSearchService {
  private readonly logger = new Logger(UnmetSearchService.name);

  constructor(
    @InjectRepository(UnmetSearch)
    private readonly searches: Repository<UnmetSearch>,
  ) {}

  async record(
    drafts: UnmetSearchDraft[],
    conversationId?: string,
  ): Promise<void> {
    // The model sometimes runs the same search twice in one turn; that is one want.
    const seen = new Set<string>();
    const rows = drafts
      .map((draft) => ({
        query: draft.query.trim().replace(/\s+/g, ' ').slice(0, QUERY_LIMIT),
        areaId: draft.areaId,
        alternatives: draft.alternatives,
        conversationId: conversationId ?? null,
      }))
      .filter((row) => {
        const key = `${row.query.toLowerCase()}|${row.areaId ?? ''}`;
        if (!row.query || seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    if (rows.length === 0) return;

    try {
      await this.searches.insert(rows);
    } catch (error) {
      this.logger.warn(
        `Could not record ${rows.length} unmet search(es): ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
