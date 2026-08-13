import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
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
   *
   * One entry crediting the net would balance to the same number and forget both figures,
   * leaving a vendor asking why a ₦6,000 order paid ₦4,800 with nothing in the ledger to
   * answer them. It would also leave Recommend's own revenue unrecorded here.
   *
   * Both rows go in one transaction, so a crash between them cannot leave a gross credit
   * standing without its commission — which would silently overpay.
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

  /**
   * Append entries, discarding any whose key is already present.
   *
   * `ON CONFLICT DO NOTHING` rather than a read-then-write check: the check would leave a
   * window between the two in which a concurrent delivery of the same event also finds
   * nothing, and both then credit. The unique index closes it in the database, where the
   * race actually happens.
   *
   * Returns how many rows were new.
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

  /**
   * The balance, summed rather than stored.
   *
   * A stored balance is the classic way to lose money: one double-processed event and the
   * number is wrong with no way to find out where. Summing is slower and always explicable.
   */
  /**
   * Pass `manager` when the caller holds a lock: read it on their connection, or the sum
   * comes from outside their transaction and the lock has protected nothing.
   */
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
