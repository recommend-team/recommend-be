import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, Logger } from '@nestjs/common';
import { WithdrawalsService } from './withdrawals.service';
import { WalletService, NewEntry } from './wallet.service';
import { Withdrawal, WithdrawalStatus } from './entities/withdrawal.entity';
import { Account, AccountStatus } from './entities/account.entity';
import { WalletEntryType } from './entities/wallet-entry.entity';
import {
  InsufficientPaystackBalanceError,
  PaymentsService,
  TransferNotPermittedError,
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

const DUPLICATE =
  'Please provide a unique reference. Reference already exists on a transfer';

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
  let payments: { initiateTransfer: jest.Mock; verifyTransfer: jest.Mock };
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

  /** The debit `request` made, which every withdrawal row in these tests has behind it. */
  const debited = (): void => {
    ledger.push({
      userId: 'u1',
      type: WalletEntryType.WITHDRAWAL,
      amount: -4800,
      idempotencyKey: 'withdrawal:w1',
      withdrawalId: 'w1',
    });
  };

  /** Ledger total for the withdrawal: -4800 while debited, 0 once refunded. */
  const net = (): number =>
    ledger
      .filter((e) => e.withdrawalId === 'w1')
      .reduce((sum, e) => sum + e.amount, 0);

  const refunds = (): NewEntry[] =>
    ledger.filter((e) => e.type === WalletEntryType.WITHDRAWAL_REVERSED);

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
      verifyTransfer: jest.fn().mockResolvedValue({ found: false }),
    };
    email = { sendEmail: jest.fn().mockResolvedValue(undefined) };

    // Behaves like the real ledger: keys are unique, and a withdrawal's net is the sum
    // of its own entries.
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
      withdrawalNet: jest.fn((_m: EntityManager, withdrawalId: string) => {
        const own = ledger.filter((e) => e.withdrawalId === withdrawalId);
        return Promise.resolve({
          net: own.reduce((sum, e) => sum + e.amount, 0),
          count: own.length,
        });
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
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
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
      expect(lockOrder.slice(0, 2)).toEqual(['lock', 'balance']);
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

    it('accepted by Paystack: processing, still debited, nothing refunded', async () => {
      const result = await service.request(user, 'acc1', 4800);

      expect(result.status).toBe(WithdrawalStatus.PROCESSING);
      expect(result.transferCode).toBe('TRF_1');
      expect(net()).toBe(-4800);
    });
  });

  describe('when Paystack has not settled yet', () => {
    it('stays processing and keeps the debit, because it will still land', async () => {
      payments.initiateTransfer.mockRejectedValue(
        new InsufficientPaystackBalanceError('Your balance is not enough'),
      );

      const result = await service.request(user, 'acc1', 4800);

      expect(result.status).toBe(WithdrawalStatus.PROCESSING);
      // Not reversed — reversing here would show the vendor their money bouncing back
      // and forth for something that is merely slow.
      expect(refunds()).toHaveLength(0);
    });

    it('gives up and returns the money once attempts run out', async () => {
      debited();
      payments.initiateTransfer.mockRejectedValue(
        new InsufficientPaystackBalanceError('Your balance is not enough'),
      );

      const row = withdrawal({ attempts: 7 });
      await service.send(row);

      expect(row.status).toBe(WithdrawalStatus.FAILED);
      expect(refunds()).toEqual([
        expect.objectContaining({ amount: 4800, withdrawalId: 'w1' }),
      ]);
      expect(net()).toBe(0);
    });
  });

  describe('when the transfer call errors', () => {
    beforeEach(debited);

    it('refunds a refusal only once Paystack confirms it has no such transfer', async () => {
      payments.initiateTransfer.mockRejectedValue(
        new TransferRejectedError('Recipient account is frozen'),
      );

      const row = withdrawal();
      await service.send(row);

      expect(payments.verifyTransfer).toHaveBeenCalledWith('WDR-ABC');
      expect(row.status).toBe(WithdrawalStatus.FAILED);
      expect(net()).toBe(0);
    });

    it('does not refund a refusal when Paystack shows the money went', async () => {
      payments.initiateTransfer.mockRejectedValue(
        new TransferRejectedError('Something odd'),
      );
      payments.verifyTransfer.mockResolvedValue({
        found: true,
        status: 'success',
        transferCode: 'TRF_9',
        reason: null,
      });

      const row = withdrawal();
      await service.send(row);

      expect(row.status).toBe(WithdrawalStatus.SETTLED);
      expect(refunds()).toHaveLength(0);
      expect(net()).toBe(-4800);
    });

    it('never refunds a duplicate-reference refusal, which means the money already went', async () => {
      // What production did: the sweep re-sent a paid transfer, Paystack refused the
      // repeat, and the refusal was refunded on top of the payment.
      payments.initiateTransfer.mockRejectedValue(
        new TransferRejectedError(DUPLICATE),
      );
      payments.verifyTransfer.mockResolvedValue({
        found: true,
        status: 'success',
        transferCode: 'TRF_1',
        reason: null,
      });

      const row = withdrawal();
      await service.send(row);

      expect(row.status).toBe(WithdrawalStatus.SETTLED);
      expect(refunds()).toHaveLength(0);
    });

    it('keeps a duplicate refusal processing even if Paystack shows nothing, and says so', async () => {
      payments.initiateTransfer.mockRejectedValue(
        new TransferRejectedError(DUPLICATE),
      );
      const logged: string[] = [];
      jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((message: unknown) => {
          logged.push(String(message));
        });

      const row = withdrawal();
      await service.send(row);

      expect(row.status).toBe(WithdrawalStatus.PROCESSING);
      expect(refunds()).toHaveLength(0);
      expect(logged.join(' ')).toMatch(/duplicate/i);
    });

    it('keeps it processing when Paystack cannot be asked', async () => {
      payments.initiateTransfer.mockRejectedValue(
        new TransferRejectedError('Recipient account is frozen'),
      );
      payments.verifyTransfer.mockRejectedValue(new Error('timeout'));

      const row = withdrawal();
      await service.send(row);

      expect(row.status).toBe(WithdrawalStatus.PROCESSING);
      expect(net()).toBe(-4800);
    });

    it('flags an account-level block as blocking everyone, not this vendor', async () => {
      // Observed from Paystack on a test key before the business is upgraded. Retrying
      // cannot help, and it will fail every vendor's withdrawal identically.
      payments.initiateTransfer.mockRejectedValue(
        new TransferNotPermittedError(
          'You cannot initiate third party payouts as a starter business',
        ),
      );
      const logged: string[] = [];
      jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((message: unknown) => {
          logged.push(String(message));
        });

      const row = withdrawal();
      await service.send(row);

      expect(row.status).toBe(WithdrawalStatus.FAILED);
      expect(logged.join(' ')).toMatch(/BLOCKED FOR EVERY VENDOR/);
      expect(net()).toBe(0);
    });

    it('keeps a network failure retryable, since it may have landed', async () => {
      payments.initiateTransfer.mockRejectedValue(new Error('socket hang up'));

      const row = withdrawal();
      await service.send(row);

      expect(row.status).toBe(WithdrawalStatus.PROCESSING);
      expect(net()).toBe(-4800);
    });
  });

  describe('a transfer waiting for an OTP', () => {
    it('stays processing with the debit, because it goes out once the OTP is entered', async () => {
      // The first production withdrawal was refunded here, and then paid.
      debited();
      payments.initiateTransfer.mockResolvedValue({
        transferCode: 'TRF_1',
        status: 'otp',
      });

      const row = withdrawal({ status: WithdrawalStatus.REQUESTED });
      await service.send(row);

      expect(row.status).toBe(WithdrawalStatus.PROCESSING);
      expect(row.failureReason).toMatch(/OTP/);
      expect(net()).toBe(-4800);
    });
  });

  describe('returning the money', () => {
    beforeEach(debited);

    it('credits back exactly once however many times it is told', async () => {
      const row = withdrawal();

      await service.fail(row, 'first');
      await service.fail(row, 'second');
      await service.fail(row, 'third');

      expect(refunds()).toHaveLength(1);
      expect(net()).toBe(0);
    });

    it('credits the full amount, fee included', async () => {
      // We were charged nothing for a transfer that never went out.
      await service.fail(withdrawal(), 'rejected');

      expect(refunds()[0]?.amount).toBe(4800);
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
      expect(refunds()).toHaveLength(0);
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

      expect(refunds()).toEqual([expect.objectContaining({ amount: 4800 })]);
      expect(net()).toBe(0);
    });
  });

  describe('settling', () => {
    beforeEach(debited);

    it('marks it settled and leaves the ledger alone', async () => {
      const row = withdrawal();
      withdrawals.findOne.mockResolvedValue(row);

      await service.settle('WDR-ABC');

      expect(row.status).toBe(WithdrawalStatus.SETTLED);
      expect(row.settledAt).toBeInstanceOf(Date);
      expect(ledger).toHaveLength(1);
    });

    it('ignores a webhook for a reference we do not know', async () => {
      withdrawals.findOne.mockResolvedValue(null);

      await expect(service.settle('WDR-NOPE')).resolves.toBeUndefined();
    });

    it('takes back a refund when Paystack turns out to have paid it', async () => {
      // Refunded on a misread refusal, then Paystack's success arrives.
      const row = withdrawal();
      await service.fail(row, 'misread refusal');
      expect(net()).toBe(0);
      withdrawals.findOne.mockResolvedValue(row);

      await service.settle('WDR-ABC');

      expect(row.status).toBe(WithdrawalStatus.SETTLED);
      expect(net()).toBe(-4800);
      expect(ledger[ledger.length - 1]).toMatchObject({
        type: WalletEntryType.WITHDRAWAL,
        amount: -4800,
      });
    });

    it('takes it back only once, however many times success arrives', async () => {
      const row = withdrawal();
      await service.fail(row, 'misread refusal');
      withdrawals.findOne.mockResolvedValue(row);

      await service.settle('WDR-ABC');
      await service.settle('WDR-ABC');
      await service.settle('WDR-ABC');

      expect(net()).toBe(-4800);
    });

    it('still refunds a genuine reversal after a refund was taken back', async () => {
      // Fixed keys would have discarded this second refund as a repeat of the first.
      const row = withdrawal();
      await service.fail(row, 'misread refusal');
      withdrawals.findOne.mockResolvedValue(row);
      await service.settle('WDR-ABC');

      await service.failByReference(
        'WDR-ABC',
        'bank returned it',
        WithdrawalStatus.REVERSED,
      );

      expect(row.status).toBe(WithdrawalStatus.REVERSED);
      expect(net()).toBe(0);
    });
  });

  describe('the retry sweep', () => {
    beforeEach(debited);

    it('sends again on the same reference only when Paystack has nothing under it', async () => {
      const row = withdrawal({ attempts: 3 });

      await service.reconcile(row);

      expect(payments.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ reference: 'WDR-ABC' }),
      );
      expect(row.attempts).toBe(4);
      expect(row.lastAttemptAt).toBeInstanceOf(Date);
    });

    it('does not send a transfer Paystack already has', async () => {
      payments.verifyTransfer.mockResolvedValue({
        found: true,
        status: 'pending',
        transferCode: 'TRF_1',
        reason: null,
      });

      const row = withdrawal();
      await service.reconcile(row);

      expect(payments.initiateTransfer).not.toHaveBeenCalled();
      expect(row.status).toBe(WithdrawalStatus.PROCESSING);
      expect(net()).toBe(-4800);
    });

    it('settles one Paystack paid, without sending', async () => {
      payments.verifyTransfer.mockResolvedValue({
        found: true,
        status: 'success',
        transferCode: 'TRF_1',
        reason: null,
      });

      const row = withdrawal();
      await service.reconcile(row);

      expect(payments.initiateTransfer).not.toHaveBeenCalled();
      expect(row.status).toBe(WithdrawalStatus.SETTLED);
    });

    it('refunds one Paystack reports failed', async () => {
      payments.verifyTransfer.mockResolvedValue({
        found: true,
        status: 'failed',
        transferCode: 'TRF_1',
        reason: 'Account closed',
      });

      const row = withdrawal();
      await service.reconcile(row);

      expect(row.status).toBe(WithdrawalStatus.FAILED);
      expect(row.failureReason).toBe('Account closed');
      expect(net()).toBe(0);
    });

    it('treats a status it does not know as still in flight', async () => {
      payments.verifyTransfer.mockResolvedValue({
        found: true,
        status: 'some_new_status',
        transferCode: 'TRF_1',
        reason: null,
      });

      const row = withdrawal();
      await service.reconcile(row);

      expect(row.status).toBe(WithdrawalStatus.PROCESSING);
      expect(net()).toBe(-4800);
    });

    it('does nothing it cannot undo when Paystack cannot be asked', async () => {
      payments.verifyTransfer.mockRejectedValue(new Error('timeout'));

      const row = withdrawal();
      await service.reconcile(row);

      expect(payments.initiateTransfer).not.toHaveBeenCalled();
      expect(row.status).toBe(WithdrawalStatus.PROCESSING);
      expect(net()).toBe(-4800);
    });
  });
});
