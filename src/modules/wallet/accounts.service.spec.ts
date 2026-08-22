import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { Account, AccountStatus } from './entities/account.entity';
import {
  AccountResolutionError,
  PaymentsService,
} from '../payments/payments.service';
import { EmailService } from '../../common/services/email.service';
import { User } from '../auth/entities/auth.entity';

const CONFIG: Record<string, number> = {
  'wallet.maxPayoutAccounts': 4,
  'wallet.codeTtlMinutes': 15,
  'wallet.maxCodeAttempts': 5,
  'wallet.resendSeconds': 60,
  'wallet.bankListCacheHours': 24,
};

const user = { id: 'u1', email: 'ada@example.com', firstName: 'Ada' } as User;

describe('AccountsService', () => {
  let service: AccountsService;
  let rows: Account[];
  let accounts: {
    find: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let payments: {
    listBanks: jest.Mock;
    resolveAccount: jest.Mock;
    createTransferRecipient: jest.Mock;
  };
  let email: { sendEmail: jest.Mock };
  /** The plaintext code the service emailed, which only the owner would have. */
  let sentCode: string;

  const pending = (over: Partial<Account> = {}): Account =>
    ({
      id: 'a1',
      userId: 'u1',
      bankName: 'Guaranty Trust Bank',
      bankCode: '058',
      accountNumber: '0123456789',
      accountName: 'ADA OBI',
      status: AccountStatus.PENDING_VERIFICATION,
      isDefault: false,
      verificationAttempts: 0,
      verificationExpiresAt: new Date(Date.now() + 600_000),
      paystackRecipientCode: null,
      ...over,
    }) as Account;

  beforeEach(async () => {
    rows = [];
    sentCode = '';

    accounts = {
      find: jest.fn(() => Promise.resolve(rows)),
      findOne: jest.fn(() => Promise.resolve(rows[0] ?? null)),
      count: jest.fn(() =>
        Promise.resolve(
          rows.filter((r) => r.status === AccountStatus.ACTIVE).length,
        ),
      ),
      create: jest.fn((data: Partial<Account>) => ({ id: 'a1', ...data })),
      save: jest.fn((row: Account) => {
        if (!rows.includes(row)) rows.push(row);
        return Promise.resolve(row);
      }),
    };

    payments = {
      listBanks: jest.fn().mockResolvedValue([
        { name: 'Guaranty Trust Bank', code: '058', slug: 'gtb' },
        { name: 'Kuda', code: '090267', slug: 'kuda' },
      ]),
      resolveAccount: jest.fn().mockResolvedValue({
        accountNumber: '0123456789',
        accountName: 'ADA OBI',
      }),
      createTransferRecipient: jest.fn().mockResolvedValue('RCP_abc123'),
    };

    email = {
      sendEmail: jest.fn((options: { context?: { code?: string } }) => {
        if (options.context?.code) sentCode = options.context.code;
        return Promise.resolve();
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountsService,
        { provide: getRepositoryToken(Account), useValue: accounts },
        { provide: PaymentsService, useValue: payments },
        { provide: EmailService, useValue: email },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => CONFIG[key]) },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: (work: (m: unknown) => Promise<unknown>) =>
              work({ update: jest.fn(), findOne: jest.fn() }),
          },
        },
      ],
    }).compile();

    service = module.get(AccountsService);
  });

  describe('adding an account', () => {
    it('stores the name Paystack resolved, not one the user could type', async () => {
      accounts.findOne.mockResolvedValue(null);

      const account = await service.add(user, {
        bankCode: '058',
        accountNumber: '0123456789',
      });

      expect(payments.resolveAccount).toHaveBeenCalledWith('0123456789', '058');
      expect(account.accountName).toBe('ADA OBI');
      expect(account.status).toBe(AccountStatus.PENDING_VERIFICATION);
    });

    it('saves nothing when the account does not exist at that bank', async () => {
      accounts.findOne.mockResolvedValue(null);
      payments.resolveAccount.mockRejectedValue(
        new AccountResolutionError('Cannot resolve account name'),
      );

      await expect(
        service.add(user, { bankCode: '058', accountNumber: '9999999999' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(accounts.save).not.toHaveBeenCalled();
      expect(email.sendEmail).not.toHaveBeenCalled();
    });

    it('refuses a bank Paystack does not support', async () => {
      accounts.findOne.mockResolvedValue(null);

      await expect(
        service.add(user, { bankCode: '999', accountNumber: '0123456789' }),
      ).rejects.toThrow(/not supported/i);
    });

    it('emails a six-digit code rather than storing one in the clear', async () => {
      accounts.findOne.mockResolvedValue(null);

      const account = await service.add(user, {
        bankCode: '058',
        accountNumber: '0123456789',
      });

      expect(sentCode).toMatch(/^\d{6}$/);
      expect(account.verificationCodeHash).not.toContain(sentCode);
      expect(account.verificationCodeHash).toMatch(/^\$argon2/);
    });

    it('does not register the account for payouts before it is confirmed', async () => {
      accounts.findOne.mockResolvedValue(null);

      await service.add(user, {
        bankCode: '058',
        accountNumber: '0123456789',
      });

      expect(payments.createTransferRecipient).not.toHaveBeenCalled();
    });
  });

  describe('verifying', () => {
    const addThenVerify = async (code?: string) => {
      accounts.findOne.mockResolvedValue(null);
      const account = await service.add(user, {
        bankCode: '058',
        accountNumber: '0123456789',
      });
      accounts.findOne.mockResolvedValue(account);
      return service.verify(user, account.id, code ?? sentCode);
    };

    it('registers the account with Paystack and stores the recipient code', async () => {
      const account = await addThenVerify();

      expect(payments.createTransferRecipient).toHaveBeenCalledWith({
        name: 'ADA OBI',
        accountNumber: '0123456789',
        bankCode: '058',
      });
      expect(account.status).toBe(AccountStatus.ACTIVE);
      expect(account.paystackRecipientCode).toBe('RCP_abc123');
    });

    it('makes the first verified account the default', async () => {
      const account = await addThenVerify();

      expect(account.isDefault).toBe(true);
    });

    it('leaves a later account off the default', async () => {
      rows.push(pending({ id: 'existing', status: AccountStatus.ACTIVE }));

      const account = await addThenVerify();

      expect(account.isDefault).toBe(false);
    });

    it('forgets the code once it has been used', async () => {
      const account = await addThenVerify();

      expect(account.verificationCodeHash).toBeNull();
      expect(account.verificationAttempts).toBe(0);
    });

    it('rejects a wrong code and counts the attempt', async () => {
      accounts.findOne.mockResolvedValue(null);
      const account = await service.add(user, {
        bankCode: '058',
        accountNumber: '0123456789',
      });
      accounts.findOne.mockResolvedValue(account);

      await expect(service.verify(user, account.id, '000000')).rejects.toThrow(
        /not correct/i,
      );
      expect(account.verificationAttempts).toBe(1);
      expect(payments.createTransferRecipient).not.toHaveBeenCalled();
    });

    it('voids the account after five wrong codes', async () => {
      accounts.findOne.mockResolvedValue(null);
      const account = await service.add(user, {
        bankCode: '058',
        accountNumber: '0123456789',
      });
      accounts.findOne.mockResolvedValue(account);

      for (let i = 0; i < 4; i++) {
        await expect(
          service.verify(user, account.id, '000000'),
        ).rejects.toThrow();
      }
      await expect(service.verify(user, account.id, '000000')).rejects.toThrow(
        /too many/i,
      );

      // Voided, not merely blocked — a live guessable row invites a sixth attempt from a
      // fresh session.
      expect(account.status).toBe(AccountStatus.REMOVED);
      expect(account.verificationCodeHash).toBeNull();
    });

    it('refuses an expired code', async () => {
      accounts.findOne.mockResolvedValue(
        pending({ verificationExpiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(service.verify(user, 'a1', '123456')).rejects.toThrow(
        /expired/i,
      );
    });
  });

  describe('the account limit', () => {
    it('is checked at verification, so a pending account occupies no slot', async () => {
      // Three verified plus this pending one — the cap is four, so this must be allowed.
      for (let i = 0; i < 3; i++) {
        rows.push(pending({ id: `live${i}`, status: AccountStatus.ACTIVE }));
      }

      accounts.findOne.mockResolvedValue(null);
      const account = await service.add(user, {
        bankCode: '058',
        accountNumber: '0123456789',
      });
      accounts.findOne.mockResolvedValue(account);

      await expect(
        service.verify(user, account.id, sentCode),
      ).resolves.toMatchObject({ status: AccountStatus.ACTIVE });
    });

    it('refuses the fifth at verification, not at add', async () => {
      for (let i = 0; i < 4; i++) {
        rows.push(pending({ id: `live${i}`, status: AccountStatus.ACTIVE }));
      }

      accounts.findOne.mockResolvedValue(null);
      const account = await service.add(user, {
        bankCode: '058',
        accountNumber: '0123456789',
      });
      accounts.findOne.mockResolvedValue(account);

      // Adding was allowed; verifying is where it stops.
      await expect(
        service.verify(user, account.id, sentCode),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(payments.createTransferRecipient).not.toHaveBeenCalled();
    });
  });

  describe('resending', () => {
    it('refuses a second code within the throttle window', async () => {
      accounts.findOne.mockResolvedValue(
        pending({ lastCodeSentAt: new Date() }),
      );

      await expect(service.resend(user, 'a1')).rejects.toThrow(/wait/i);
    });

    it('issues a different code once the window has passed', async () => {
      const account = pending({
        lastCodeSentAt: new Date(Date.now() - 120_000),
        verificationCodeHash: 'old-hash',
      });
      accounts.findOne.mockResolvedValue(account);

      await service.resend(user, 'a1');

      expect(sentCode).toMatch(/^\d{6}$/);
      expect(account.verificationCodeHash).not.toBe('old-hash');
    });

    it('refuses to resend for an account already verified', async () => {
      accounts.findOne.mockResolvedValue(
        pending({ status: AccountStatus.ACTIVE }),
      );

      await expect(service.resend(user, 'a1')).rejects.toThrow(
        /already verified/i,
      );
    });
  });

  describe('the bank list', () => {
    it('comes from Paystack, so an unsupported bank cannot be picked', async () => {
      const banks = await service.listBanks();

      expect(banks.map((b) => b.code)).toEqual(['058', '090267']);
    });
  });
});
