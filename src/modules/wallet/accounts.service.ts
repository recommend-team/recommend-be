import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, Not, Repository } from 'typeorm';
import { randomInt } from 'crypto';
import type Redis from 'ioredis';
import * as argon2 from 'argon2';
import { Account, AccountStatus } from './entities/account.entity';
import {
  AccountResolutionError,
  Bank,
  PaymentsService,
  ResolvedAccount,
} from '../payments/payments.service';
import { EmailService } from '../../common/services/email.service';
import { User } from '../auth/entities/auth.entity';

const BANK_LIST_KEY = 'paystack:banks:NGN';

export interface AddAccountDto {
  bankCode: string;
  accountNumber: string;
}

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    @InjectRepository(Account)
    private readonly accounts: Repository<Account>,
    private readonly payments: PaymentsService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {}

  async listBanks(): Promise<Bank[]> {
    const cached = await this.redis?.get(BANK_LIST_KEY);
    if (cached) return JSON.parse(cached) as Bank[];

    const banks = await this.payments.listBanks();
    const hours = this.config.get<number>('wallet.bankListCacheHours') ?? 24;
    await this.redis?.setex(BANK_LIST_KEY, hours * 3600, JSON.stringify(banks));

    return banks;
  }

  /** Everything the user still has: verified accounts, and any awaiting a code. */
  async list(userId: string): Promise<Account[]> {
    return this.accounts.find({
      where: { userId, status: Not(AccountStatus.REMOVED) },
      order: { isDefault: 'DESC', createdAt: 'ASC' },
    });
  }

  /**
   * Resolve the account with Paystack, then hold it pending an emailed code.
   *
   * Nothing is stored if resolution fails — a vendor with unusable payout details should
   * find out while typing them, not when their first withdrawal bounces.
   */
  async add(user: User, dto: AddAccountDto): Promise<Account> {
    const existing = await this.accounts.findOne({
      where: {
        userId: user.id,
        accountNumber: dto.accountNumber,
        bankCode: dto.bankCode,
        status: Not(AccountStatus.REMOVED),
      },
    });
    if (existing) {
      throw new ConflictException('You have already added that account.');
    }

    let resolved: ResolvedAccount;
    try {
      resolved = await this.payments.resolveAccount(
        dto.accountNumber,
        dto.bankCode,
      );
    } catch (error) {
      if (error instanceof AccountResolutionError) {
        throw new BadRequestException(
          'We could not find that account at that bank. Check the number and try again.',
        );
      }
      throw error;
    }

    const bank = (await this.listBanks()).find(
      (candidate) => candidate.code === dto.bankCode,
    );
    if (!bank) {
      throw new BadRequestException('That bank is not supported.');
    }

    const { code, hash, expiresAt } = await this.newCode();

    const account = await this.accounts.save(
      this.accounts.create({
        userId: user.id,
        bankName: bank.name,
        bankCode: dto.bankCode,
        accountNumber: dto.accountNumber,
        accountName: resolved.accountName,
        status: AccountStatus.PENDING_VERIFICATION,
        verificationCodeHash: hash,
        verificationExpiresAt: expiresAt,
        verificationAttempts: 0,
        lastCodeSentAt: new Date(),
      }),
    );

    await this.sendCode(user, account, code);

    return account;
  }

  /**
   * Turn a pending account into one money can be sent to.
   *
   * The limit is checked here rather than at `add`, because pending accounts do not count
   * towards it — a user with three verified accounts and one pending has three, and being
   * told otherwise would be wrong.
   */
  async verify(user: User, accountId: string, code: string): Promise<Account> {
    const account = await this.own(user.id, accountId);

    if (account.status === AccountStatus.ACTIVE) return account;

    if (
      !account.verificationCodeHash ||
      !account.verificationExpiresAt ||
      account.verificationExpiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException(
        'That code has expired. Ask for a new one.',
      );
    }

    const maxAttempts = this.config.get<number>('wallet.maxCodeAttempts') ?? 5;
    if (account.verificationAttempts >= maxAttempts) {
      throw new BadRequestException(
        'Too many incorrect codes. Add the account again.',
      );
    }

    if (!(await argon2.verify(account.verificationCodeHash, code))) {
      account.verificationAttempts += 1;

      // Voided rather than merely blocked: leaving a guessable row alive after five
      // attempts just invites a sixth from a fresh session.
      if (account.verificationAttempts >= maxAttempts) {
        account.status = AccountStatus.REMOVED;
        account.removedAt = new Date();
        account.verificationCodeHash = null;
        await this.accounts.save(account);
        throw new BadRequestException(
          'Too many incorrect codes. Add the account again.',
        );
      }

      await this.accounts.save(account);
      throw new BadRequestException(
        `That code is not correct. ${maxAttempts - account.verificationAttempts} attempt(s) left.`,
      );
    }

    const max = this.config.get<number>('wallet.maxPayoutAccounts') ?? 4;
    const active = await this.accounts.count({
      where: { userId: user.id, status: AccountStatus.ACTIVE },
    });
    if (active >= max) {
      throw new ConflictException(
        `You can have at most ${max} payout accounts. Remove one before adding another.`,
      );
    }

    const recipientCode = await this.payments.createTransferRecipient({
      name: account.accountName,
      accountNumber: account.accountNumber,
      bankCode: account.bankCode,
    });

    account.paystackRecipientCode = recipientCode;
    account.status = AccountStatus.ACTIVE;
    account.verifiedAt = new Date();
    account.verificationCodeHash = null;
    account.verificationExpiresAt = null;
    account.verificationAttempts = 0;
    // The first one that works becomes the default, so withdrawal never opens with a
    // choice the user has no basis to make.
    account.isDefault = active === 0;

    const saved = await this.accounts.save(account);

    await this.notifyChanged(user, saved);

    return saved;
  }

  async resend(user: User, accountId: string): Promise<void> {
    const account = await this.own(user.id, accountId);

    if (account.status !== AccountStatus.PENDING_VERIFICATION) {
      throw new BadRequestException('That account is already verified.');
    }

    const waitSeconds = this.config.get<number>('wallet.resendSeconds') ?? 60;
    const since = account.lastCodeSentAt
      ? (Date.now() - account.lastCodeSentAt.getTime()) / 1000
      : Number.POSITIVE_INFINITY;
    if (since < waitSeconds) {
      throw new BadRequestException(
        `Wait ${Math.ceil(waitSeconds - since)} more second(s) before asking for another code.`,
      );
    }

    const { code, hash, expiresAt } = await this.newCode();
    account.verificationCodeHash = hash;
    account.verificationExpiresAt = expiresAt;
    account.lastCodeSentAt = new Date();
    await this.accounts.save(account);

    await this.sendCode(user, account, code);
  }

  async setDefault(userId: string, accountId: string): Promise<Account> {
    const account = await this.own(userId, accountId);

    if (account.status !== AccountStatus.ACTIVE) {
      throw new BadRequestException(
        'Verify that account before making it the default.',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      await manager.update(
        Account,
        { userId, isDefault: true },
        { isDefault: false },
      );
      await manager.update(Account, { id: accountId }, { isDefault: true });
      account.isDefault = true;
      return account;
    });
  }

  /**
   * Retire an account. Requires the password, or an attacker removes the real ones and
   * the owner cannot withdraw ahead of them.
   */
  async remove(user: User, accountId: string): Promise<void> {
    const account = await this.own(user.id, accountId);

    if (account.status === AccountStatus.REMOVED) return;

    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        Account,
        { id: accountId },
        {
          status: AccountStatus.REMOVED,
          removedAt: new Date(),
          isDefault: false,
        },
      );

      // Never leave a user with accounts but no default.
      if (account.isDefault) {
        const next = await manager.findOne(Account, {
          where: { userId: user.id, status: AccountStatus.ACTIVE },
          order: { createdAt: 'ASC' },
        });
        if (next) {
          await manager.update(Account, { id: next.id }, { isDefault: true });
        }
      }
    });

    await this.notifyChanged(user, account, 'removed');
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private async own(userId: string, accountId: string): Promise<Account> {
    const account = await this.accounts.findOne({
      where: { id: accountId, userId },
    });
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }

  private async newCode(): Promise<{
    code: string;
    hash: string;
    expiresAt: Date;
  }> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const minutes = this.config.get<number>('wallet.codeTtlMinutes') ?? 15;

    return {
      code,
      hash: await argon2.hash(code),
      expiresAt: new Date(Date.now() + minutes * 60_000),
    };
  }

  private async sendCode(
    user: User,
    account: Account,
    code: string,
  ): Promise<void> {
    const minutes = this.config.get<number>('wallet.codeTtlMinutes') ?? 15;

    await this.email.sendEmail({
      to: user.email,
      subject: 'Confirm your payout account',
      template: 'payout-account-code',
      context: {
        name: user.firstName,
        code,
        minutes,
        bankName: account.bankName,
        masked: mask(account.accountNumber),
        accountName: account.accountName,
      },
    });
  }

  /**
   * Tell the owner their payout accounts changed. Prevents nothing — it turns a silent
   * theft into a loud one while the balance is still there.
   */
  private async notifyChanged(
    user: User,
    account: Account,
    action: 'added' | 'removed' = 'added',
  ): Promise<void> {
    try {
      await this.email.sendEmail({
        to: user.email,
        subject: 'Your payout accounts changed',
        template: 'payout-account-changed',
        context: {
          name: user.firstName,
          action,
          bankName: account.bankName,
          masked: mask(account.accountNumber),
        },
      });
    } catch (error) {
      // A warning that cannot be delivered must not undo the change the user asked for.
      this.logger.error(
        `Could not tell ${user.id} their payout accounts changed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}

function mask(accountNumber: string): string {
  return `••••${accountNumber.slice(-4)}`;
}
