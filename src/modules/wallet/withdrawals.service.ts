import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, In, LessThan, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { Withdrawal, WithdrawalStatus } from './entities/withdrawal.entity';
import { Account, AccountStatus } from './entities/account.entity';
import { WalletEntryType } from './entities/wallet-entry.entity';
import { WalletService } from './wallet.service';
import {
  InsufficientPaystackBalanceError,
  PaymentsService,
  TransferLookup,
  TransferNotPermittedError,
  TransferRejectedError,
  TransferResult,
} from '../payments/payments.service';
import { EmailService } from '../../common/services/email.service';
import { User } from '../auth/entities/auth.entity';
import type { FeeTier } from '../../config/configuration';
import {
  WITHDRAWAL_FAILED_EVENT,
  WITHDRAWAL_SETTLED_EVENT,
  WithdrawalFailedEvent,
  WithdrawalSettledEvent,
} from '../../common/events/wallet.events';

/** Paystack transfer statuses meaning the bank has the money. */
const PAID = new Set(['success']);

/**
 * Statuses meaning no money went and none will. `reversed` is handled on its own: the
 * money went and came back. Anything not listed here or in PAID — pending, processing,
 * otp, received, or a word Paystack adds later — is treated as still in flight, which
 * keeps the debit. Mistaking an unknown status for a failure is what pays twice.
 */
const UNPAID = new Set(['failed', 'abandoned', 'blocked', 'rejected']);

/** Our statuses in which the amount has been credited back to the wallet. */
const REFUNDED = new Set<WithdrawalStatus>([
  WithdrawalStatus.FAILED,
  WithdrawalStatus.REVERSED,
]);

const OTP_NOTE =
  'Waiting for the transfer OTP on Paystack. Turn off Transfers OTP in the Paystack dashboard.';

/** One row of the admin withdrawals page: who, to where, and how it went. */
export interface AdminWithdrawal {
  id: string;
  reference: string;
  status: WithdrawalStatus;
  amountRequested: number;
  feeAmount: number;
  amountSent: number;
  failureReason: string | null;
  attempts: number;
  transferCode: string | null;
  lastAttemptAt: Date | null;
  settledAt: Date | null;
  createdAt: Date;
  vendor: {
    id: string;
    name: string;
    businessName: string | null;
    email: string;
  } | null;
  account: {
    bankName: string;
    accountNumber: string;
    accountName: string;
  } | null;
}

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
    private readonly events: EventEmitter2,
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
   * One attempt at the transfer, for a reference Paystack has nothing under.
   *
   * Called for a fresh withdrawal, and otherwise only after `verifyTransfer` has said
   * Paystack holds no transfer with this reference. Sending a reference it already has
   * is refused as a duplicate — which is how a paid withdrawal was once read as a
   * failure and refunded.
   */
  async send(withdrawal: Withdrawal): Promise<void> {
    withdrawal.attempts += 1;
    withdrawal.lastAttemptAt = new Date();

    let result: TransferResult;
    try {
      result = await this.payments.initiateTransfer({
        amountNgn: Number(withdrawal.amountSent),
        recipientCode: withdrawal.recipientCode,
        reference: withdrawal.reference,
        reason: 'Recommend payout',
      });
    } catch (error) {
      await this.afterRefusedSend(withdrawal, error);
      return;
    }

    const awaitingOtp = result.status === 'otp';
    await this.transition(withdrawal, {
      status: WithdrawalStatus.PROCESSING,
      attempts: withdrawal.attempts,
      lastAttemptAt: withdrawal.lastAttemptAt,
      transferCode: result.transferCode || withdrawal.transferCode,
      failureReason: awaitingOtp ? OTP_NOTE : null,
    });

    if (awaitingOtp) {
      this.warnOtp(withdrawal);
    } else {
      this.logger.log(
        `Transfer ${withdrawal.reference} accepted by Paystack (${result.status})`,
      );
    }
  }

  /**
   * The transfer call came back as an error. That is not proof the money stayed put, so
   * Paystack is asked what it holds under this reference before anything is refunded.
   */
  private async afterRefusedSend(
    withdrawal: Withdrawal,
    error: unknown,
  ): Promise<void> {
    const message = errorMessage(error);

    let lookup: TransferLookup;
    try {
      lookup = await this.payments.verifyTransfer(withdrawal.reference);
    } catch (verifyError) {
      // We cannot tell whether it went. Keep the debit and ask again on the next sweep.
      this.logger.warn(
        `Transfer ${withdrawal.reference} errored (${message}) and could not be verified (${errorMessage(verifyError)}) — will check again`,
      );
      await this.keepWaiting(withdrawal, message);
      return;
    }

    if (lookup.found) {
      await this.applyLookup(withdrawal, lookup);
      return;
    }

    // Paystack has nothing under this reference. Only now does the error mean what it says.

    if (isDuplicateReference(message)) {
      // Refused as a duplicate, yet nothing to show for it. A contradiction is never a
      // reason to refund: leave it for a person, with the debit in place.
      this.logger.error(
        `Paystack refused ${withdrawal.reference} as a duplicate but has no transfer under it — left processing for an admin to check`,
      );
      await this.keepWaiting(withdrawal, message);
      return;
    }

    // Our Paystack balance has not settled yet. Nothing is wrong with the request: stay
    // processing and let the sweep send it again; the vendor is told it is on its way,
    // which is true.
    if (error instanceof InsufficientPaystackBalanceError) {
      await this.keepWaiting(withdrawal, message);

      const max = this.maxAttempts();
      if (withdrawal.attempts >= max) {
        this.logger.error(
          `Withdrawal ${withdrawal.reference} gave up after ${max} attempts waiting for settlement`,
        );
        await this.fail(withdrawal, `Not settled after ${max} attempts`);
      }
      return;
    }

    if (error instanceof TransferNotPermittedError) {
      this.logger.error(
        `PAYOUTS ARE BLOCKED FOR EVERY VENDOR — Paystack said: ${message}`,
      );
      await this.fail(withdrawal, message);
      return;
    }

    if (error instanceof TransferRejectedError) {
      await this.fail(withdrawal, message);
      return;
    }

    // Network or a Paystack 5xx with no transfer created. The sweep looks again and, if
    // Paystack still has nothing, sends on the same reference.
    await this.keepWaiting(withdrawal, message);
    this.logger.warn(
      `Transfer ${withdrawal.reference} did not go through (${message}) — will retry`,
    );
  }

  /**
   * Find out what happened to an in-flight withdrawal, and act on that.
   *
   * What the sweep and the admin's Retry do. Sends again only when Paystack confirms it
   * has no transfer under the reference — never on the assumption that it does not.
   */
  async reconcile(withdrawal: Withdrawal): Promise<void> {
    let lookup: TransferLookup;
    try {
      lookup = await this.payments.verifyTransfer(withdrawal.reference);
    } catch (error) {
      this.logger.warn(
        `Could not verify ${withdrawal.reference} (${errorMessage(error)}) — will check again`,
      );
      // Pushes it to the back of the queue, so one unreachable lookup does not hog the sweep.
      await this.transition(withdrawal, {
        status: withdrawal.status,
        lastAttemptAt: new Date(),
      });
      return;
    }

    if (!lookup.found) {
      await this.send(withdrawal);
      return;
    }

    withdrawal.lastAttemptAt = new Date();
    await this.applyLookup(withdrawal, lookup);
  }

  /** Everything waiting on a retry that is now due. */
  async due(): Promise<Withdrawal[]> {
    const minutes =
      this.config.get<number>('wallet.withdrawalRetryMinutes') ?? 30;
    const cutoff = new Date(Date.now() - minutes * 60_000);

    return this.withdrawals.find({
      where: [
        {
          status: WithdrawalStatus.PROCESSING,
          lastAttemptAt: LessThan(cutoff),
        },
        // Debited but never sent — the process stopped between the two.
        { status: WithdrawalStatus.REQUESTED, createdAt: LessThan(cutoff) },
      ],
      order: { lastAttemptAt: 'ASC' },
      take: 25,
    });
  }

  // ─── Outcomes ───────────────────────────────────────────────────────────────

  /** Act on what Paystack says it holds under the withdrawal's reference. */
  private async applyLookup(
    withdrawal: Withdrawal,
    lookup: Extract<TransferLookup, { found: true }>,
  ): Promise<void> {
    if (PAID.has(lookup.status)) {
      await this.settleWithdrawal(withdrawal);
      return;
    }

    if (lookup.status === 'reversed') {
      await this.fail(
        withdrawal,
        lookup.reason ?? 'Paystack reversed the transfer',
        WithdrawalStatus.REVERSED,
      );
      return;
    }

    if (UNPAID.has(lookup.status)) {
      await this.fail(
        withdrawal,
        lookup.reason ?? `Paystack marked the transfer ${lookup.status}`,
      );
      return;
    }

    // Still with Paystack — pending, processing, waiting for an OTP, or a word we do not
    // know. None of those is a failure, so the money stays debited.
    const awaitingOtp = lookup.status === 'otp';
    const wasRefunded = REFUNDED.has(withdrawal.status);
    await this.transition(
      withdrawal,
      {
        status: WithdrawalStatus.PROCESSING,
        lastAttemptAt: withdrawal.lastAttemptAt ?? new Date(),
        transferCode: lookup.transferCode ?? withdrawal.transferCode,
        failureReason: awaitingOtp ? OTP_NOTE : null,
      },
      wasRefunded
        ? 'Paystack is still sending this withdrawal, so the earlier refund is taken back'
        : undefined,
    );

    if (wasRefunded) {
      this.logger.error(
        `Withdrawal ${withdrawal.reference} had been refunded but Paystack is still sending it (${lookup.status}) — refund taken back`,
      );
    }
    if (awaitingOtp) this.warnOtp(withdrawal);
  }

  async settle(reference: string): Promise<void> {
    const withdrawal = await this.byReference(reference);
    if (!withdrawal) return;
    await this.settleWithdrawal(withdrawal);
  }

  /**
   * The bank has the money.
   *
   * If it had been refunded — a refusal read as a failure before anyone asked Paystack —
   * the refund is taken back in the same transaction, or the vendor keeps both.
   */
  private async settleWithdrawal(withdrawal: Withdrawal): Promise<void> {
    if (withdrawal.status === WithdrawalStatus.SETTLED) return;

    const wasRefunded = REFUNDED.has(withdrawal.status);
    await this.transition(
      withdrawal,
      {
        status: WithdrawalStatus.SETTLED,
        settledAt: new Date(),
        failureReason: null,
      },
      wasRefunded
        ? 'Paystack confirmed this withdrawal was paid, so the earlier refund is taken back'
        : undefined,
    );

    if (wasRefunded) {
      this.logger.error(
        `Withdrawal ${withdrawal.reference} had been refunded but Paystack paid it — refund of ₦${withdrawal.amountRequested} taken back`,
      );
    } else {
      this.logger.log(
        `Withdrawal ${withdrawal.reference} settled — ₦${withdrawal.amountSent} reached the bank`,
      );
    }

    this.events.emit(
      WITHDRAWAL_SETTLED_EVENT,
      new WithdrawalSettledEvent(
        withdrawal.userId,
        withdrawal.id,
        withdrawal.reference,
        Number(withdrawal.amountSent),
      ),
    );
  }

  /**
   * Give up, and give the money back.
   *
   * Only for an outcome Paystack itself reported, or a reference it confirmed it does not
   * have. The credit is worked out from the ledger, so a webhook delivered twice — or one
   * racing the sweep — returns the balance exactly once.
   */
  async fail(
    withdrawal: Withdrawal,
    reason: string,
    status:
      | WithdrawalStatus.FAILED
      | WithdrawalStatus.REVERSED = WithdrawalStatus.FAILED,
  ): Promise<void> {
    if (REFUNDED.has(withdrawal.status)) return;

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

    await this.transition(
      withdrawal,
      { status, failureReason: reason },
      reason,
    );

    this.logger.warn(
      `Withdrawal ${withdrawal.reference} ${status.toLowerCase()} (${reason}) — ₦${withdrawal.amountRequested} returned`,
    );

    this.events.emit(
      WITHDRAWAL_FAILED_EVENT,
      new WithdrawalFailedEvent(
        withdrawal.userId,
        withdrawal.id,
        withdrawal.reference,
        Number(withdrawal.amountRequested),
        reason,
        status === WithdrawalStatus.REVERSED,
      ),
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

  /**
   * Change a withdrawal's status and make the wallet agree with it, in one transaction.
   *
   * The ledger's view follows from the status: debited, unless the withdrawal finally
   * failed. What is actually on the ledger for it is summed and the difference appended,
   * so a refund can be taken back — and a genuine failure after that refunded again —
   * without ever moving the money twice.
   *
   * Returns the amount the balance moved: positive for money returned, negative taken.
   */
  private async transition(
    withdrawal: Withdrawal,
    changes: Partial<Withdrawal> & { status: WithdrawalStatus },
    note?: string,
  ): Promise<number> {
    let moved = 0;

    await this.dataSource.transaction(async (manager) => {
      // The same lock `request` takes, so a correction and a new withdrawal can never
      // both read the balance mid-change.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        withdrawal.userId,
      ]);

      await manager.update(Withdrawal, { id: withdrawal.id }, changes);

      const target = REFUNDED.has(changes.status)
        ? 0
        : -Number(withdrawal.amountRequested);
      const { net, count } = await this.wallet.withdrawalNet(
        manager,
        withdrawal.id,
      );
      moved = round2(target - net);

      if (moved !== 0) {
        await this.wallet.append(manager, [
          {
            userId: withdrawal.userId,
            type:
              moved > 0
                ? WalletEntryType.WITHDRAWAL_REVERSED
                : WalletEntryType.WITHDRAWAL,
            amount: moved,
            // Numbered by how many entries came before, so each correction is its own
            // row while a replay of the same one is discarded.
            idempotencyKey: `${moved > 0 ? 'reversal' : 'redebit'}:${withdrawal.id}:${count}`,
            withdrawalId: withdrawal.id,
            note: note ?? null,
          },
        ]);
      }
    });

    Object.assign(withdrawal, changes);
    return moved;
  }

  /** Still with Paystack, or not yet sendable: keep the debit and look again later. */
  private async keepWaiting(
    withdrawal: Withdrawal,
    reason: string | null,
  ): Promise<void> {
    await this.transition(withdrawal, {
      status: WithdrawalStatus.PROCESSING,
      attempts: withdrawal.attempts,
      lastAttemptAt: withdrawal.lastAttemptAt ?? new Date(),
      failureReason: reason,
    });
  }

  private warnOtp(withdrawal: Withdrawal): void {
    this.logger.error(
      `Transfer ${withdrawal.reference} is waiting for an OTP on Paystack — EVERY WITHDRAWAL WILL WAIT until Transfers OTP is turned off in the Paystack dashboard`,
    );
  }

  // ─── Admin ──────────────────────────────────────────────────────────────────

  /**
   * Every withdrawal, in flight ones first, then newest first. Ordering matters: the
   * first reason to open this list is to find what is not moving; the second is history.
   */
  async listForAdmin(query: {
    status?: WithdrawalStatus;
    /** A reference, or part of the vendor's business name, name or email. */
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{
    items: AdminWithdrawal[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    const qb = this.withdrawals
      .createQueryBuilder('w')
      .orderBy(
        `CASE w.status WHEN 'PROCESSING' THEN 0 WHEN 'REQUESTED' THEN 1 ELSE 2 END`,
        'ASC',
      )
      .addOrderBy('w.createdAt', 'DESC')
      .offset((page - 1) * limit)
      .limit(limit);

    if (query.status)
      qb.andWhere('w.status = :status', { status: query.status });

    const search = query.search?.trim();
    if (search) {
      qb.andWhere(
        `(w.reference ILIKE :term OR w."userId" IN (
          SELECT u.id FROM users u
          WHERE u."businessName" ILIKE :term OR u.email ILIKE :term
             OR (u."firstName" || ' ' || u."lastName") ILIKE :term
        ))`,
        { term: `%${search}%` },
      );
    }

    const [rows, total] = await qb.getManyAndCount();

    // No relations on the entity, so the two lookups are done once for the whole page.
    const userIds = [...new Set(rows.map((w) => w.userId))];
    const accountIds = [...new Set(rows.map((w) => w.accountId))];
    const [users, accounts] = await Promise.all([
      userIds.length
        ? this.dataSource.getRepository(User).find({
            where: { id: In(userIds) },
            select: ['id', 'firstName', 'lastName', 'businessName', 'email'],
          })
        : Promise.resolve<User[]>([]),
      accountIds.length
        ? this.accounts.find({ where: { id: In(accountIds) } })
        : Promise.resolve<Account[]>([]),
    ]);
    const usersById = new Map(users.map((u) => [u.id, u]));
    const accountsById = new Map(accounts.map((a) => [a.id, a]));

    return {
      items: rows.map((w) => {
        const user = usersById.get(w.userId);
        const account = accountsById.get(w.accountId);
        return {
          id: w.id,
          reference: w.reference,
          status: w.status,
          amountRequested: Number(w.amountRequested),
          feeAmount: Number(w.feeAmount),
          amountSent: Number(w.amountSent),
          failureReason: w.failureReason,
          attempts: w.attempts,
          transferCode: w.transferCode,
          lastAttemptAt: w.lastAttemptAt,
          settledAt: w.settledAt,
          createdAt: w.createdAt,
          vendor: user
            ? {
                id: user.id,
                name: `${user.firstName} ${user.lastName}`.trim(),
                businessName: user.businessName,
                email: user.email,
              }
            : null,
          account: account
            ? {
                bankName: account.bankName,
                accountNumber: account.accountNumber,
                accountName: account.accountName,
              }
            : null,
        };
      }),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Retry an in-flight withdrawal now, rather than waiting for the sweep.
   *
   * Asks Paystack first and only sends if it has nothing under the reference, so this
   * can never pay twice. One that was refunded is not retried — the vendor already has
   * the money back; `verifyNow` is how to see whether it was paid after all.
   */
  async retryNow(id: string): Promise<Withdrawal> {
    const withdrawal = await this.findForAdmin(id);

    if (withdrawal.status === WithdrawalStatus.SETTLED) {
      throw new BadRequestException(
        'That withdrawal is settled — there is nothing to retry.',
      );
    }
    if (REFUNDED.has(withdrawal.status)) {
      throw new BadRequestException(
        'That withdrawal was refunded, so it is not sent again. Use "Check Paystack" to see whether it was paid after all.',
      );
    }

    await this.reconcile(withdrawal);
    return withdrawal;
  }

  /**
   * Ask Paystack what happened to any withdrawal, and correct ours to match.
   *
   * The way to fix one refunded by mistake: if Paystack paid it, it is settled and the
   * refund taken back. Never sends anything.
   */
  async verifyNow(id: string): Promise<Withdrawal> {
    const withdrawal = await this.findForAdmin(id);
    if (withdrawal.status === WithdrawalStatus.SETTLED) return withdrawal;

    if (!REFUNDED.has(withdrawal.status)) {
      await this.reconcile(withdrawal);
      return withdrawal;
    }

    const lookup = await this.lookupForAdmin(withdrawal);
    // Paystack never had it: the refund was right, and it stays.
    if (lookup.found) await this.applyLookup(withdrawal, lookup);
    return withdrawal;
  }

  /**
   * Give up on one by hand, returning the money — only once Paystack confirms it was not
   * paid and is not still being sent.
   */
  async abandon(id: string, reason: string): Promise<Withdrawal> {
    const withdrawal = await this.findForAdmin(id);

    if (withdrawal.status === WithdrawalStatus.SETTLED) {
      throw new BadRequestException(
        'That withdrawal is settled — the bank has the money, so there is nothing to refund.',
      );
    }
    if (REFUNDED.has(withdrawal.status)) return withdrawal;

    const lookup = await this.lookupForAdmin(withdrawal);

    if (lookup.found && PAID.has(lookup.status)) {
      // Paid after all. Settled instead, and the caller is told so by the status.
      await this.settleWithdrawal(withdrawal);
      return withdrawal;
    }

    if (
      lookup.found &&
      lookup.status !== 'reversed' &&
      !UNPAID.has(lookup.status)
    ) {
      throw new BadRequestException(
        `Paystack is still sending this withdrawal (${lookup.status}), so it cannot be refunded. If it fails, the money returns by itself.`,
      );
    }

    await this.fail(
      withdrawal,
      reason,
      lookup.found && lookup.status === 'reversed'
        ? WithdrawalStatus.REVERSED
        : WithdrawalStatus.FAILED,
    );
    return withdrawal;
  }

  private async findForAdmin(id: string): Promise<Withdrawal> {
    const withdrawal = await this.withdrawals.findOne({ where: { id } });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found');
    return withdrawal;
  }

  /** A lookup an admin is waiting on: an unreachable Paystack is their error to see. */
  private async lookupForAdmin(
    withdrawal: Withdrawal,
  ): Promise<TransferLookup> {
    try {
      return await this.payments.verifyTransfer(withdrawal.reference);
    } catch (error) {
      throw new BadRequestException(
        `Could not confirm with Paystack what happened to this withdrawal, so nothing was changed. Try again. (${errorMessage(error)})`,
      );
    }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/**
 * Paystack's refusal of a reference it already has — "Please provide a unique reference.
 * Reference already exists on a transfer". It means the money already went.
 */
function isDuplicateReference(message: string): boolean {
  const normalised = message.toLowerCase();
  return (
    normalised.includes('unique reference') ||
    normalised.includes('reference already exists') ||
    normalised.includes('duplicate')
  );
}
