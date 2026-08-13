import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { WalletEntry, WalletEntryType } from './entities/wallet-entry.entity';
import { VendorOrderCompletedEvent } from '../../common/events/vendor-order-completed.event';

export interface NewEntry {
  userId: string;
  type: WalletEntryType;
  amount: number;
  idempotencyKey: string;
  orderId?: string | null;
  withdrawalId?: string | null;
  note?: string | null;
}

export interface WalletSummary {
  balance: number;
  entryCount: number;
}

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @InjectRepository(WalletEntry)
    private readonly entries: Repository<WalletEntry>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * What an order earned its vendor, as two entries: the gross they sold, and the
   * commission we took.
   */
  async creditEarning(event: VendorOrderCompletedEvent): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const written = await this.append(manager, [
        {
          userId: event.vendorId,
          type: WalletEntryType.EARNING,
          amount: event.subtotal,
          idempotencyKey: `earning:${event.orderId}`,
          orderId: event.orderId,
        },
        {
          userId: event.vendorId,
          type: WalletEntryType.COMMISSION,
          amount: -event.platformFee,
          idempotencyKey: `commission:${event.orderId}`,
          orderId: event.orderId,
        },
      ]);

      if (written === 0) {
        this.logger.debug(
          `Order ${event.orderId} was already credited — nothing written`,
        );
      } else {
        this.logger.log(
          `Credited vendor ${event.vendorId} ${event.vendorAmount} for order ${event.orderId} (ref=${event.reference})`,
        );
      }

      return written;
    });
  }

  async adjust(params: {
    userId: string;
    amount: number;
    note: string;
    adminId: string;
  }): Promise<WalletEntry> {
    return this.dataSource.transaction(async (manager) => {
      await this.append(manager, [
        {
          userId: params.userId,
          type: WalletEntryType.ADJUSTMENT,
          amount: params.amount,
          idempotencyKey: `adjustment:${randomUUID()}`,
          note: `${params.note} (by admin ${params.adminId})`,
        },
      ]);

      this.logger.warn(
        `Admin ${params.adminId} adjusted ${params.userId} by ${params.amount}: ${params.note}`,
      );

      return manager.findOneOrFail(WalletEntry, {
        where: { userId: params.userId },
        order: { createdAt: 'DESC', id: 'DESC' },
      });
    });
  }

  /**
   * Append entries, discarding any whose key is already present.

   */
  async append(manager: EntityManager, rows: NewEntry[]): Promise<number> {
    if (rows.length === 0) return 0;

    const result = await manager
      .createQueryBuilder()
      .insert()
      .into(WalletEntry)
      .values(
        rows.map((row) => ({
          userId: row.userId,
          type: row.type,
          amount: row.amount,
          idempotencyKey: row.idempotencyKey,
          orderId: row.orderId ?? null,
          withdrawalId: row.withdrawalId ?? null,
          note: row.note ?? null,
        })),
      )
      .orIgnore()
      .execute();

    return result.identifiers.filter(Boolean).length;
  }

  async balanceOf(userId: string, manager?: EntityManager): Promise<number> {
    return (await this.summaryOf(userId, manager)).balance;
  }

  async summaryOf(
    userId: string,
    manager?: EntityManager,
  ): Promise<WalletSummary> {
    const repository = manager
      ? manager.getRepository(WalletEntry)
      : this.entries;

    const row = await repository
      .createQueryBuilder('entry')
      .select('COALESCE(SUM(entry.amount), 0)', 'balance')
      .addSelect('COUNT(entry.id)', 'count')
      .where('entry.userId = :userId', { userId })
      .getRawOne<{ balance: string; count: string }>();

    return {
      balance: round2(Number(row?.balance ?? 0)),
      entryCount: Number(row?.count ?? 0),
    };
  }

  /** The statement, newest first. */
  async entriesOf(
    userId: string,
    options: { limit: number; offset: number },
  ): Promise<{ entries: WalletEntry[]; total: number }> {
    const [entries, total] = await this.entries.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: options.limit,
      skip: options.offset,
    });

    return {
      entries: entries.map((entry) => ({
        ...entry,
        amount: round2(Number(entry.amount)),
      })),
      total,
    };
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
