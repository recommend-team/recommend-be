import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { WithdrawalsService } from './withdrawals.service';

/**
 * Retries transfers that could not go out yet.
 *
 * A charge reaches our Paystack balance on Paystack's settlement cycle, not instantly, so
 * a vendor whose ledger balance is entirely correct can still be told there is no money
 * to send. Retrying keeps "withdraw anytime" honest without us parking capital there.
 *
 * Safe because every attempt reuses the withdrawal's own reference, which Paystack
 * deduplicates — a retry either completes the original or is ignored.
 */
@Injectable()
export class WithdrawalRetryService {
  private readonly logger = new Logger(WithdrawalRetryService.name);
  /** Distinct from the payment sweep's, or the two would block each other. */
  private static readonly LOCK_KEY = 8_724_310_156;

  constructor(
    private readonly withdrawals: WithdrawalsService,
    private readonly dataSource: DataSource,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweep(): Promise<void> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();

    try {
      const rows = (await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [WithdrawalRetryService.LOCK_KEY],
      )) as { locked: boolean }[];

      // Another instance has it. Two instances retrying the same transfer would be
      // deduplicated by Paystack anyway, but there is no reason to spend the calls.
      if (!rows[0]?.locked) return;

      try {
        await this.retryDue();
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1)', [
          WithdrawalRetryService.LOCK_KEY,
        ]);
      }
    } catch (error) {
      this.logger.error(
        `Withdrawal retry sweep failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    } finally {
      await runner.release();
    }
  }

  private async retryDue(): Promise<void> {
    const due = await this.withdrawals.due();
    if (due.length === 0) return;

    this.logger.log(`Retrying ${due.length} withdrawal(s)`);

    for (const withdrawal of due) {
      try {
        await this.withdrawals.send(withdrawal);
      } catch (error) {
        // One stuck withdrawal must not stop the rest of the queue.
        this.logger.error(
          `Retry of ${withdrawal.reference} threw: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }
}
