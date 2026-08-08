import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, DataSource, Repository } from 'typeorm';
import { Checkout } from './entities/checkout.entity';
import { OrdersService } from './orders.service';
import { OrderStatus } from '../../common/enums/order-status.enum';

/**
 * The safety net under every payment.
 *
 * A paid order only becomes real once *something* tells us the money moved. Two things
 * can: Paystack's webhook, and the buyer's own app when it next asks. Both depend on
 * someone being there — the webhook can be lost or arrive while we are mid-deploy, and a
 * buyer who pays and closes the tab never asks again.
 */
@Injectable()
export class PaymentReconciliationService {
  private readonly logger = new Logger(PaymentReconciliationService.name);
  private static readonly GRACE_MINUTES = 10;
  private static readonly LOOKBACK_HOURS = 12;
  private static readonly MAX_PER_RUN = 50;
  private static readonly LOCK_KEY = 8_724_310_155;

  constructor(
    @InjectRepository(Checkout)
    private readonly checkouts: Repository<Checkout>,
    private readonly ordersService: OrdersService,
    private readonly dataSource: DataSource,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweep(): Promise<void> {
    try {
      await this.sweepUnderLock();
    } catch (error) {
      this.logger.error(
        `Payment sweep failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  private async sweepUnderLock(): Promise<void> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();

    try {
      const rows = (await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [PaymentReconciliationService.LOCK_KEY],
      )) as { locked: boolean }[];

      // Another instance is already on it. Not a problem, and not worth logging noisily.
      if (!rows[0]?.locked) return;

      try {
        await this.reconcile();
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1)', [
          PaymentReconciliationService.LOCK_KEY,
        ]);
      }
    } finally {
      await runner.release();
    }
  }

  private async reconcile(): Promise<void> {
    const now = Date.now();
    const newest = new Date(
      now - PaymentReconciliationService.GRACE_MINUTES * 60_000,
    );
    const oldest = new Date(
      now - PaymentReconciliationService.LOOKBACK_HOURS * 3_600_000,
    );

    const pending = await this.checkouts.find({
      where: {
        status: OrderStatus.PENDING_PAYMENT,
        createdAt: Between(oldest, newest),
      },
      select: ['id', 'reference'],
      order: { createdAt: 'ASC' },
      take: PaymentReconciliationService.MAX_PER_RUN,
    });

    if (pending.length === 0) return;

    let recovered = 0;

    for (const checkout of pending) {
      try {
        await this.ordersService.confirmByReference(checkout.reference);

        // Re-read rather than trust the call: confirmByReference deliberately says
        // nothing about what it decided, and only the row is authoritative.
        const settled = await this.checkouts.findOne({
          where: { id: checkout.id },
          select: ['status'],
        });
        if (settled?.status === OrderStatus.PAID) {
          recovered++;
          this.logger.warn(
            `Payment sweep recovered ${checkout.reference} — paid at Paystack but never confirmed here`,
          );
        }
      } catch (error) {
        // One unreachable gateway call must not abandon the rest of the batch.
        this.logger.error(
          `Payment sweep could not check ${checkout.reference}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    if (pending.length === PaymentReconciliationService.MAX_PER_RUN) {
      // Never let a capped batch read as full coverage.
      this.logger.warn(
        `Payment sweep hit its ${PaymentReconciliationService.MAX_PER_RUN}-order cap — more may be waiting, next run continues`,
      );
    }

    this.logger.log(
      `Payment sweep: checked ${pending.length}, recovered ${recovered}`,
    );
  }
}
