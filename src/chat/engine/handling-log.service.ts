import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  ConversationHandling,
  HandlingEndReason,
} from '../conversation/entities/conversation-handling.entity';

/** One agent's figures over a period. Times are in seconds; null when nothing to average. */
export interface AgentStats {
  adminId: string;
  /** Chats they took (or were given) in the period. */
  handled: number;
  /** Chats they have right now, whenever they took them. */
  openNow: number;
  /** How long buyers had been waiting when this agent picked them up. */
  avgPickupSeconds: number | null;
  /** From taking a chat to their first message in it. */
  avgFirstReplySeconds: number | null;
  /** Handed back automatically because they went quiet on a waiting buyer. */
  wentIdle: number;
}

/**
 * The record of who answered which chat — written as chats are taken, answered, handed
 * back and passed on.
 *
 * Every write is best-effort. The history describes the work; it must never stop an agent
 * taking a chat or a reply reaching a buyer.
 */
@Injectable()
export class HandlingLogService {
  private readonly logger = new Logger(HandlingLogService.name);

  constructor(
    @InjectRepository(ConversationHandling)
    private readonly handlings: Repository<ConversationHandling>,
  ) {}

  /** Someone has the chat now — taken from the queue, or given to them by an admin. */
  async started(
    conversationId: string,
    adminId: string,
    details: { waitingSince: Date | null; assignedByAdminId?: string | null },
  ): Promise<void> {
    await this.quietly('record a chat being taken', async () => {
      // Anything still open belongs to whoever had it before; this is a new spell.
      const open = await this.handlings.findOne({
        where: { conversationId, endedAt: IsNull() },
      });
      if (open?.adminId === adminId) return; // Re-taking your own: the same spell.

      await this.handlings.insert({
        conversationId,
        adminId,
        waitingSince: details.waitingSince,
        takenAt: new Date(),
        assignedByAdminId: details.assignedByAdminId ?? null,
        firstReplyAt: null,
        endedAt: null,
        endReason: null,
        endedByAdminId: null,
      });
    });
  }

  /** They wrote to the buyer. Only the first message of a spell is kept. */
  async replied(conversationId: string, adminId: string): Promise<void> {
    await this.quietly('record a first reply', () =>
      this.handlings.update(
        {
          conversationId,
          adminId,
          endedAt: IsNull(),
          firstReplyAt: IsNull(),
        },
        { firstReplyAt: new Date() },
      ),
    );
  }

  /** Whoever had it doesn't any more. */
  async ended(
    conversationId: string,
    reason: HandlingEndReason,
    endedByAdminId: string | null = null,
  ): Promise<void> {
    await this.quietly('record a chat being let go', () =>
      this.handlings.update(
        { conversationId, endedAt: IsNull() },
        { endedAt: new Date(), endReason: reason, endedByAdminId },
      ),
    );
  }

  /** Everyone who has answered this chat, first to last. */
  history(conversationId: string): Promise<ConversationHandling[]> {
    return this.handlings.find({
      where: { conversationId },
      order: { takenAt: 'ASC' },
      take: 100,
    });
  }

  /** Per-agent figures for chats taken in `[from, to)`, plus what each has open now. */
  async stats(from: Date, to: Date): Promise<AgentStats[]> {
    const period = await this.handlings
      .createQueryBuilder('h')
      .select('h."adminId"', 'adminId')
      .addSelect('COUNT(*)', 'handled')
      // A chat an admin handed to someone was not waiting on *them*: left out.
      .addSelect(
        `AVG(EXTRACT(EPOCH FROM (h."takenAt" - h."waitingSince"))) FILTER (WHERE h."waitingSince" IS NOT NULL AND h."assignedByAdminId" IS NULL)`,
        'avgPickupSeconds',
      )
      .addSelect(
        `AVG(EXTRACT(EPOCH FROM (h."firstReplyAt" - h."takenAt"))) FILTER (WHERE h."firstReplyAt" IS NOT NULL)`,
        'avgFirstReplySeconds',
      )
      .addSelect(`COUNT(*) FILTER (WHERE h."endReason" = :idle)`, 'wentIdle')
      .where('h."takenAt" >= :from AND h."takenAt" < :to', { from, to })
      .setParameter('idle', HandlingEndReason.IDLE)
      .groupBy('h."adminId"')
      .getRawMany<{
        adminId: string;
        handled: string;
        avgPickupSeconds: string | null;
        avgFirstReplySeconds: string | null;
        wentIdle: string;
      }>();

    const open = await this.handlings
      .createQueryBuilder('h')
      .select('h."adminId"', 'adminId')
      .addSelect('COUNT(*)', 'openNow')
      .where('h."endedAt" IS NULL')
      .groupBy('h."adminId"')
      .getRawMany<{ adminId: string; openNow: string }>();

    const byAdmin = new Map<string, AgentStats>();
    for (const row of period) {
      byAdmin.set(row.adminId, {
        adminId: row.adminId,
        handled: Number(row.handled),
        openNow: 0,
        avgPickupSeconds: seconds(row.avgPickupSeconds),
        avgFirstReplySeconds: seconds(row.avgFirstReplySeconds),
        wentIdle: Number(row.wentIdle),
      });
    }
    for (const row of open) {
      const stats = byAdmin.get(row.adminId) ?? {
        adminId: row.adminId,
        handled: 0,
        openNow: 0,
        avgPickupSeconds: null,
        avgFirstReplySeconds: null,
        wentIdle: 0,
      };
      stats.openNow = Number(row.openNow);
      byAdmin.set(row.adminId, stats);
    }
    return [...byAdmin.values()];
  }

  private async quietly(what: string, work: () => Promise<unknown>) {
    try {
      await work();
    } catch (error) {
      this.logger.error(
        `Could not ${what}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}

function seconds(raw: string | null): number | null {
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.round(value) : null;
}
