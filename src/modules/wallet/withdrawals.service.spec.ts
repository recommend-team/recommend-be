import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { WithdrawalsService } from './withdrawals.service';
import { WalletService, NewEntry } from './wallet.service';
import { Withdrawal, WithdrawalStatus } from './entities/withdrawal.entity';
import { Account, AccountStatus } from './entities/account.entity';
import { WalletEntryType } from './entities/wallet-entry.entity';
import {
  InsufficientPaystackBalanceError,
  PaymentsService,
  TransferOtpRequiredError,
  TransferRejectedError,
} from '../payments/payments.service';
import { EmailService } from '../../common/services/email.service';
import { User } from '../auth/entities/auth.entity';

const CONFIG: Record<string, unknown> = {
  'wallet.minWithdrawalNgn': 2000,
  'wallet.withdrawalRetryMinutes': 30,
  'wallet.withdrawalMaxAttempts': 8,
  'wallet.transferFeeTiers': [
    { upTo: 5000, fee: 10 },
    { upTo: 50000, fee: 25 },
    { upTo: null, fee: 50 },
  ],
};

const user = { id: 'u1', email: 'ada@example.com', firstName: 'Ada' } as User;

describe('WithdrawalsService', () => {
  let service: WithdrawalsService;
  let ledger: NewEntry[];
  let balance: number;
  let saved: Withdrawal[];
  let withdrawals: {
    find: jest.Mock;
    findOne: jest.Mock;
    findOneOrFail: jest.Mock;
    save: jest.Mock;
  };
  let accounts: { findOne: jest.Mock };
  let payments: { initiateTransfer: jest.Mock };
  let email: { sendEmail: jest.Mock };
  /** Whether the advisory lock was taken, and when relative to reading the balance. */
  let lockOrder: string[];

  const account = (over: Partial<Account> = {}): Account =>
    ({
      id: 'acc1',
      userId: 'u1',
      status: AccountStatus.ACTIVE,
      paystackRecipientCode: 'RCP_1',
      bankName: 'GTB',
      accountNumber: '0123456789',
      ...over,
    }) as Account;

  const withdrawal = (over: Partial<Withdrawal> = {}): Withdrawal =>
    ({
      id: 'w1',
      userId: 'u1',
      accountId: 'acc1',
      amountRequested: 4800,
      feeAmount: 10,
      amountSent: 4790,
      status: WithdrawalStatus.PROCESSING,
      reference: 'WDR-ABC',
      recipientCode: 'RCP_1',
      attempts: 1,
      ...over,
    }) as Withdrawal;

  beforeEach(async () => {
    ledger = [];
    balance = 10000;
    saved = [];
    lockOrder = [];

    const manager = {
      query: jest.fn((sql: string) => {
        lockOrder.push(sql.includes('advisory') ? 'lock' : 'other');
        return Promise.resolve([]);
      }),
      create: (_entity: unknown, data: Record<string, unknown>) => ({
        id: 'w1',
        ...data,
      }),
      save: jest.fn((row: Withdrawal) => {
        saved.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(),
    } as unknown as EntityManager;

    withdrawals = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      findOneOrFail: jest.fn(() => Promise.resolve(saved[saved.length - 1])),
      save: jest.fn((row: Withdrawal) => Promise.resolve(row)),
    };

    accounts = { findOne: jest.fn().mockResolvedValue(account()) };
    payments = {
      initiateTransfer: jest
        .fn()
        .mockResolvedValue({ transferCode: 'TRF_1', status: 'pending' }),
    };
    email = { sendEmail: jest.fn().mockResolvedValue(undefined) };

    const wallet = {
      balanceOf: jest.fn(() => {
        lockOrder.push('balance');
        return Promise.resolve(balance);
      }),
      append: jest.fn((_m: EntityManager, rows: NewEntry[]) => {
        for (const row of rows) {
          if (!ledger.some((e) => e.idempotencyKey === row.idempotencyKey)) {
            ledger.push(row);
          }
        }
        return Promise.resolve(rows.length);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WithdrawalsService,
        { provide: getRepositoryToken(Withdrawal), useValue: withdrawals },
        { provide: getRepositoryToken(Account), useValue: accounts },
        { provide: WalletService, useValue: wallet },
        { provide: PaymentsService, useValue: payments },
        { provide: EmailService, useValue: email },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => CONFIG[key]) },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: (work: (m: EntityManager) => Promise<unknown>) =>
              work(manager),
          },
        },
      ],
    }).compile();

    service = module.get(WithdrawalsService);
  });

  describe('the fee', () => {
    it('is deducted so the vendor sees what will actually arrive', () => {
      expect(service.quote(4800)).toEqual({
        amountRequested: 4800,
        feeAmount: 10,
        amountSent: 4790,
      });
    });

    it('follows the configured tiers', () => {
      expect(service.quote(5000).feeAmount).toBe(10);
      expect(service.quote(5001).feeAmount).toBe(25);
      expect(service.quote(50000).feeAmount).toBe(25);
      expect(service.quote(50001).feeAmount).toBe(50);
    });
  });

  describe('requesting', () => {
    it('debits the full amount at request, not what is sent', async () => {
      await service.request(user, 'acc1', 4800);

      // The fee leaves our Paystack balance too, so both sides drop by 4,800.
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        type: WalletEntryType.WITHDRAWAL,
        amount: -4800,
        idempotencyKey: 'withdrawal:w1',
      });
    });

    it('sends the amount less the fee', async () => {
      await service.request(user, 'acc1', 4800);

      expect(payments.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ amountNgn: 4790, recipientCode: 'RCP_1' }),
      );
    });

    it('takes the lock before reading the balance', async () => {
      await service.request(user, 'acc1', 4800);

      // Order is the whole point. Reading the balance first and locking afterwards would
      // let two concurrent requests both see the same money and both spend it.
      expect(lockOrder).toEqual(['lock', 'balance']);
    });

    it('refuses more than the balance', async () => {
      balance = 3000;

      await expect(service.request(user, 'acc1', 4800)).rejects.toThrow(
        /available/i,
      );
      expect(ledger).toHaveLength(0);
    });

    it('refuses below the minimum', async () => {
      await expect(service.request(user, 'acc1', 500)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses an unverified account', async () => {
      accounts.findOne.mockResolvedValue(
        account({
          status: AccountStatus.PENDING_VERIFICATION,
          paystackRecipientCode: null,
        }),
      );

      await expect(service.request(user, 'acc1', 4800)).rejects.toThrow(
        /confirm that payout account/i,
      );
    });

    it('snapshots the recipient, so changing the account cannot redirect it', async () => {
      await service.request(user, 'acc1', 4800);

      expect(saved[0].recipientCode).toBe('RCP_1');
    });
  });

  describe('when Paystack has not settled yet', () => {
    it('stays processing and keeps the debit, because it will still land', async () => {
      payments.initiateTransfer.mockRejectedValue(
        new InsufficientPaystackBalanceError('Your balance is not enough'),
      );

      await service.request(user, 'acc1', 4800);

      const [row] = withdrawals.save.mock.calls.flat() as Withdrawal[];
      expect(row.status).toBe(WithdrawalStatus.PROCESSING);
      // Not reversed — reversing here would show the vendor their money bouncing back
      // and forth for something that is merely slow.
      expect(ledger.filter((e) => e.amount > 0)).toHaveLength(0);
    });

    it('gives up and returns the money once attempts run out', async () => {
      payments.initiateTransfer.mockRejectedValue(
        new InsufficientPaystackBalanceError('Your balance is not enough'),
      );

      await service.send(withdrawal({ attempts: 7 }));

      expect(ledger).toContainEqual(
        expect.objectContaining({
          type: WalletEntryType.WITHDRAWAL_REVERSED,
          amount: 4800,
          idempotencyKey: 'reversal:w1',
        }),
      );
    });
  });

  describe('when Paystack refuses outright', () => {
    it('fails immediately rather than retrying against a wall', async () => {
      payments.initiateTransfer.mockRejectedValue(
        new TransferRejectedError('Recipient account is frozen'),
      );

      const row = withdrawal();
      await service.send(row);

      expect(row.status).toBe(WithdrawalStatus.FAILED);
      expect(ledger).toContainEqual(
        expect.objectContaining({
          type: WalletEntryType.WITHDRAWAL_REVERSED,
          amount: 4800,
        }),
      );
    });

    it('treats an OTP requirement as terminal, since it blocks every transfer', async () => {
      payments.initiateTransfer.mockRejectedValue(
        new TransferOtpRequiredError('Disable Transfers OTP'),
      );

      const row = withdrawal();
      await service.send(row);

      expect(row.status).toBe(WithdrawalStatus.FAILED);
    });

    it('keeps a network failure retryable, since it may have landed', async () => {
      payments.initiateTransfer.mockRejectedValue(new Error('socket hang up'));

      const row = withdrawal();
      await service.send(row);

      expect(row.status).toBe(WithdrawalStatus.PROCESSING);
      expect(ledger).toHaveLength(0);
    });
  });

  describe('returning the money', () => {
    it('credits back exactly once however many times it is told', async () => {
      const row = withdrawal();

      await service.fail(row, 'first');
      await service.fail(row, 'second');
      await service.fail(row, 'third');

      expect(
        ledger.filter((e) => e.type === WalletEntryType.WITHDRAWAL_REVERSED),
      ).toHaveLength(1);
    });

    it('credits the full amount, fee included', async () => {
      // We were charged nothing for a transfer that never went out.
      await service.fail(withdrawal(), 'rejected');

      const reversal = ledger.find(
        (e) => e.type === WalletEntryType.WITHDRAWAL_REVERSED,
      );
      expect(reversal?.amount).toBe(4800);
    });

    it('ignores a failure that arrives after the money already settled', async () => {
      withdrawals.findOne.mockResolvedValue(
        withdrawal({ status: WithdrawalStatus.SETTLED }),
      );

      await service.failByReference(
        'WDR-ABC',
        'late webhook',
        WithdrawalStatus.FAILED,
      );

      // Settled means the bank has it. "It failed" is then a contradiction, and acting on
      // it would credit the vendor for money they already have.
      expect(ledger).toHaveLength(0);
    });

    it('honours a reversal after settlement, because that one is real', async () => {
      // Paystack sent it and then pulled it back — the balance is genuinely owed again.
      withdrawals.findOne.mockResolvedValue(
        withdrawal({ status: WithdrawalStatus.SETTLED }),
      );

      await service.failByReference(
        'WDR-ABC',
        'bank returned it',
        WithdrawalStatus.REVERSED,
      );

      expect(ledger).toContainEqual(
        expect.objectContaining({
          type: WalletEntryType.WITHDRAWAL_REVERSED,
          amount: 4800,
        }),
      );
    });
  });

  describe('settling', () => {
    it('marks it settled and stops there', async () => {
      const row = withdrawal();
      withdrawals.findOne.mockResolvedValue(row);

      await service.settle('WDR-ABC');

      expect(row.status).toBe(WithdrawalStatus.SETTLED);
      expect(row.settledAt).toBeInstanceOf(Date);
      expect(ledger).toHaveLength(0);
    });

    it('ignores a webhook for a reference we do not know', async () => {
      withdrawals.findOne.mockResolvedValue(null);

      await expect(service.settle('WDR-NOPE')).resolves.toBeUndefined();
    });
  });

  describe('retrying', () => {
    it('reuses the same reference, so Paystack cannot send twice', async () => {
      await service.send(withdrawal({ attempts: 3 }));

      expect(payments.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ reference: 'WDR-ABC' }),
      );
    });

    it('counts the attempt', async () => {
      const row = withdrawal({ attempts: 3 });

      await service.send(row);

      expect(row.attempts).toBe(4);
      expect(row.lastAttemptAt).toBeInstanceOf(Date);
    });
  });
});
