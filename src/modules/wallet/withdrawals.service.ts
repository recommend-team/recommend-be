import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, LessThan, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { Withdrawal, WithdrawalStatus } from './entities/withdrawal.entity';
import { Account, AccountStatus } from './entities/account.entity';
import { WalletEntryType } from './entities/wallet-entry.entity';
import { WalletService } from './wallet.service';
import {
  InsufficientPaystackBalanceError,
  PaymentsService,
  TransferOtpRequiredError,
  TransferRejectedError,
} from '../payments/payments.service';
import { EmailService } from '../../common/services/email.service';
import { User } from '../auth/entities/auth.entity';
import type { FeeTier } from '../../config/configuration';

export interface WithdrawalQuote {
  amountRequested: number;
  feeAmount: number;
  amountSent: number;
}

@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);

  constructor(
    @InjectRepository(Withdrawal)
    private readonly withdrawals: Repository<Withdrawal>,
    @InjectRepository(Account)
    private readonly accounts: Repository<Account>,
    private readonly wallet: WalletService,
    private readonly payments: PaymentsService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  /** What the vendor will actually receive, shown before they confirm. */
  quote(amountRequested: number): WithdrawalQuote {
    const feeAmount = this.feeFor(amountRequested);
    return {
      amountRequested: round2(amountRequested),
      feeAmount,
      amountSent: round2(amountRequested - feeAmount),
    };
  }

  async list(userId: string): Promise<Withdrawal[]> {
    return this.withdrawals.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  /**
   * Take the money out of the balance, then try to send it.
   *
   * The debit happens at request, not at settlement — otherwise two requests moments
   * apart both see the full balance and both succeed. The advisory lock serialises the
   * balance check and the debit for one user; a plain read-then-write leaves a gap wide
   * enough to withdraw twice.
   */
  async request(
    user: User,
    accountId: string,
    amountRequested: number,
  ): Promise<Withdrawal> {
    const amount = round2(amountRequested);
    const minimum = this.config.get<number>('wallet.minWithdrawalNgn') ?? 2000;

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Enter an amount to withdraw.');
    }
    if (amount < minimum) {
      throw new BadRequestException(
        `The smallest withdrawal is ₦${minimum.toLocaleString()}.`,
      );
    }

    const account = await this.accounts.findOne({
      where: { id: accountId, userId: user.id },
    });
    if (!account) throw new NotFoundException('Payout account not found');
    if (
      account.status !== AccountStatus.ACTIVE ||
      !account.paystackRecipientCode
    ) {
      throw new BadRequestException(
        'Confirm that payout account before withdrawing to it.',
      );
    }

    const quote = this.quote(amount);
    if (quote.amountSent <= 0) {
      throw new BadRequestException(
        'That amount is smaller than the transfer fee.',
      );
    }

    const withdrawal = await this.dataSource.transaction(async (manager) => {
      // Serialised per user, so a second request cannot read the balance this one is
      // about to spend. Released when the transaction ends, however it ends.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        user.id,
      ]);

      const balance = await this.wallet.balanceOf(user.id, manager);
      if (amount > balance) {
        throw new BadRequestException(
          `You have ₦${balance.toLocaleString()} available.`,
        );
      }

      const created = await manager.save(
        manager.create(Withdrawal, {
          userId: user.id,
          accountId: account.id,
          amountRequested: quote.amountRequested,
          feeAmount: quote.feeAmount,
          amountSent: quote.amountSent,
          status: WithdrawalStatus.REQUESTED,
          reference: `WDR-${randomBytes(6).toString('hex').toUpperCase()}`,
          recipientCode: account.paystackRecipientCode!,
          attempts: 0,
        }),
      );

      await this.wallet.append(manager, [
        {
          userId: user.id,
          type: WalletEntryType.WITHDRAWAL,
          amount: -quote.amountRequested,
          idempotencyKey: `withdrawal:${created.id}`,
          withdrawalId: created.id,
        },
      ]);

      return created;
    });

    await this.send(withdrawal);
    await this.notify(user, withdrawal);

    return this.withdrawals.findOneOrFail({ where: { id: withdrawal.id } });
  }

  // ─── Sending, and the retry loop ────────────────────────────────────────────

  /**
   * One attempt at the transfer. Reuses the withdrawal's own reference every time, so a
   * retry is deduplicated by Paystack rather than sending a second payment.
   */
  async send(withdrawal: Withdrawal): Promise<void> {
    withdrawal.attempts += 1;
    withdrawal.lastAttemptAt = new Date();

    try {
      const result = await this.payments.initiateTransfer({
        amountNgn: Number(withdrawal.amountSent),
        recipientCode: withdrawal.recipientCode,
        reference: withdrawal.reference,
        reason: 'Recommend payout',
      });

      withdrawal.transferCode = result.transferCode;
      withdrawal.status = WithdrawalStatus.PROCESSING;
      withdrawal.failureReason = null;
      await this.withdrawals.save(withdrawal);

      this.logger.log(
        `Transfer ${withdrawal.reference} accepted by Paystack (${result.status})`,
      );
    } catch (error) {
      await this.handleSendFailure(withdrawal, error);
    }
  }

  private async handleSendFailure(
    withdrawal: Withdrawal,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : 'unknown error';

    // Nothing is wrong with the request — our Paystack balance has not settled yet. Stay
    // PROCESSING and let the cron try again; the vendor is told it is on its way, which
    // is true.
    if (error instanceof InsufficientPaystackBalanceError) {
      withdrawal.status = WithdrawalStatus.PROCESSING;
      withdrawal.failureReason = message;
      await this.withdrawals.save(withdrawal);

      const max = this.maxAttempts();
      if (withdrawal.attempts >= max) {
        this.logger.error(
          `Withdrawal ${withdrawal.reference} gave up after ${max} attempts waiting for settlement`,
        );
        await this.fail(withdrawal, `Not settled after ${max} attempts`);
      }
      return;
    }

    if (error instanceof TransferOtpRequiredError) {
      // Every withdrawal will fail this way until the dashboard setting changes, so it is
      // logged as the configuration fault it is rather than a fault of this one transfer.
      this.logger.error(message);
      await this.fail(withdrawal, message);
      return;
    }

    if (error instanceof TransferRejectedError) {
      await this.fail(withdrawal, message);
      return;
    }

    // Network or a Paystack 5xx — unknown whether it landed. Left PROCESSING so the
    // retry, carrying the same reference, either completes it or is deduplicated.
    withdrawal.status = WithdrawalStatus.PROCESSING;
    withdrawal.failureReason = message;
    await this.withdrawals.save(withdrawal);
    this.logger.warn(
      `Transfer ${withdrawal.reference} did not go through (${message}) — will retry`,
    );
  }

  /** Everything waiting on a retry that is now due. */
  async due(): Promise<Withdrawal[]> {
    const minutes =
      this.config.get<number>('wallet.withdrawalRetryMinutes') ?? 30;
    const cutoff = new Date(Date.now() - minutes * 60_000);

    return this.withdrawals.find({
      where: {
        status: WithdrawalStatus.PROCESSING,
        lastAttemptAt: LessThan(cutoff),
      },
      order: { lastAttemptAt: 'ASC' },
      take: 25,
    });
  }

  // ─── Outcomes ───────────────────────────────────────────────────────────────

  async settle(reference: string): Promise<void> {
    const withdrawal = await this.byReference(reference);
    if (!withdrawal) return;
    if (withdrawal.status === WithdrawalStatus.SETTLED) return;

    withdrawal.status = WithdrawalStatus.SETTLED;
    withdrawal.settledAt = new Date();
    withdrawal.failureReason = null;
    await this.withdrawals.save(withdrawal);

    this.logger.log(
      `Withdrawal ${reference} settled — ₦${withdrawal.amountSent} reached the bank`,
    );
  }

  /**
   * Give up, and give the money back.
   *
   * The credit is keyed on the withdrawal, so a webhook delivered twice — or a webhook
   * racing the retry loop — returns the balance exactly once.
   */
  async fail(
    withdrawal: Withdrawal,
    reason: string,
    status:
      | WithdrawalStatus.FAILED
      | WithdrawalStatus.REVERSED = WithdrawalStatus.FAILED,
  ): Promise<void> {
    if (
      withdrawal.status === WithdrawalStatus.FAILED ||
      withdrawal.status === WithdrawalStatus.REVERSED
    ) {
      return;
    }

    // A reversal after settlement is real — Paystack sent the money and then pulled it
    // back, so the balance is genuinely owed again. A *failure* after settlement is a
    // contradiction, and acting on it would credit a vendor for money the bank has.
    if (
      withdrawal.status === WithdrawalStatus.SETTLED &&
      status === WithdrawalStatus.FAILED
    ) {
      this.logger.warn(
        `Ignoring a failure for ${withdrawal.reference}, which already settled: ${reason}`,
      );
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        Withdrawal,
        { id: withdrawal.id },
        { status, failureReason: reason },
      );

      await this.wallet.append(manager, [
        {
          userId: withdrawal.userId,
          type: WalletEntryType.WITHDRAWAL_REVERSED,
          amount: Number(withdrawal.amountRequested),
          idempotencyKey: `reversal:${withdrawal.id}`,
          withdrawalId: withdrawal.id,
          note: reason,
        },
      ]);
    });

    withdrawal.status = status;
    withdrawal.failureReason = reason;

    this.logger.warn(
      `Withdrawal ${withdrawal.reference} ${status.toLowerCase()} (${reason}) — ₦${withdrawal.amountRequested} returned`,
    );
  }

  async failByReference(
    reference: string,
    reason: string,
    status: WithdrawalStatus.FAILED | WithdrawalStatus.REVERSED,
  ): Promise<void> {
    const withdrawal = await this.byReference(reference);
    if (!withdrawal) return;
    await this.fail(withdrawal, reason, status);
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private byReference(reference: string): Promise<Withdrawal | null> {
    return this.withdrawals.findOne({ where: { reference } });
  }

  private maxAttempts(): number {
    return this.config.get<number>('wallet.withdrawalMaxAttempts') ?? 8;
  }

  private feeFor(amountNgn: number): number {
    const tiers = this.config.get<FeeTier[]>('wallet.transferFeeTiers') ?? [];
    const tier = tiers.find((t) => t.upTo === null || amountNgn <= t.upTo);
    return round2(tier?.fee ?? 0);
  }

  private async notify(user: User, withdrawal: Withdrawal): Promise<void> {
    try {
      await this.email.sendEmail({
        to: user.email,
        subject: 'Withdrawal on its way',
        template: 'withdrawal-requested',
        context: {
          name: user.firstName,
          amountSent: Number(withdrawal.amountSent).toLocaleString(),
          feeAmount: Number(withdrawal.feeAmount).toLocaleString(),
          reference: withdrawal.reference,
        },
      });
    } catch (error) {
      this.logger.error(
        `Could not email ${user.id} about withdrawal ${withdrawal.reference}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
