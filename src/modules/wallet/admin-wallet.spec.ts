import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WalletService, NewEntry } from './wallet.service';
import { WithdrawalsService } from './withdrawals.service';
import { WalletEntry, WalletEntryType } from './entities/wallet-entry.entity';
import { Withdrawal, WithdrawalStatus } from './entities/withdrawal.entity';
import { Account } from './entities/account.entity';
import { PaymentsService } from '../payments/payments.service';
import { EmailService } from '../../common/services/email.service';

describe('admin controls', () => {
  describe('WalletService.adjust', () => {
    let service: WalletService;
    let written: NewEntry[];

    beforeEach(async () => {
      written = [];

      const insertBuilder = {
        insert: () => insertBuilder,
        into: () => insertBuilder,
        values: (rows: NewEntry[]) => {
          written.push(...rows);
          return insertBuilder;
        },
        orIgnore: () => insertBuilder,
        execute: () => Promise.resolve({ identifiers: [{ id: 'e1' }] }),
      };

      const manager = {
        createQueryBuilder: () => insertBuilder,
        findOneOrFail: () => Promise.resolve({ id: 'e1' } as WalletEntry),
      } as unknown as EntityManager;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WalletService,
          { provide: getRepositoryToken(WalletEntry), useValue: {} },
          {
            provide: DataSource,
            useValue: {
              transaction: (work: (m: EntityManager) => Promise<unknown>) =>
                work(manager),
            },
          },
        ],
      }).compile();

      service = module.get(WalletService);
    });

    it('records a correction as a new entry, never an edit', async () => {
      await service.adjust({
        userId: 'u1',
        amount: 500,
        note: 'Goodwill for a late delivery',
        adminId: 'admin-1',
      });

      expect(written[0]).toMatchObject({
        type: WalletEntryType.ADJUSTMENT,
        amount: 500,
        userId: 'u1',
      });
    });

    it('names the admin in the note, so the correction is attributable', async () => {
      await service.adjust({
        userId: 'u1',
        amount: -200,
        note: 'Duplicate credit reversed',
        adminId: 'admin-7',
      });

      expect(written[0].note).toContain('admin-7');
      expect(written[0].note).toContain('Duplicate credit reversed');
    });

    it('takes a negative amount, because corrections go both ways', async () => {
      await service.adjust({
        userId: 'u1',
        amount: -1200,
        note: 'Paid by hand outside the app',
        adminId: 'admin-1',
      });

      expect(written[0].amount).toBe(-1200);
    });

    it('keys each adjustment uniquely, so two identical ones both land', async () => {
      await service.adjust({
        userId: 'u1',
        amount: 100,
        note: 'first',
        adminId: 'a',
      });
      await service.adjust({
        userId: 'u1',
        amount: 100,
        note: 'second',
        adminId: 'a',
      });

      expect(written[0].idempotencyKey).not.toBe(written[1].idempotencyKey);
    });
  });

  describe('WithdrawalsService admin actions', () => {
    let service: WithdrawalsService;
    let rows: Withdrawal[];
    let ledger: NewEntry[];
    let payments: { initiateTransfer: jest.Mock; verifyTransfer: jest.Mock };

    const withdrawal = (over: Partial<Withdrawal> = {}): Withdrawal =>
      ({
        id: 'w1',
        userId: 'u1',
        amountRequested: 4800,
        amountSent: 4790,
        status: WithdrawalStatus.PROCESSING,
        reference: 'WDR-ABC',
        recipientCode: 'RCP_1',
        attempts: 3,
        ...over,
      }) as Withdrawal;

    const found = (status: string) => ({
      found: true,
      status,
      transferCode: 'TRF',
      reason: null,
    });

    const net = (): number => ledger.reduce((sum, e) => sum + e.amount, 0);

    const refunded = (): void => {
      ledger.push({
        userId: 'u1',
        type: WalletEntryType.WITHDRAWAL_REVERSED,
        amount: 4800,
        idempotencyKey: 'reversal:w1',
        withdrawalId: 'w1',
      });
    };

    beforeEach(async () => {
      rows = [];
      // The debit `request` made.
      ledger = [
        {
          userId: 'u1',
          type: WalletEntryType.WITHDRAWAL,
          amount: -4800,
          idempotencyKey: 'withdrawal:w1',
          withdrawalId: 'w1',
        },
      ];
      payments = {
        initiateTransfer: jest
          .fn()
          .mockResolvedValue({ transferCode: 'TRF', status: 'pending' }),
        verifyTransfer: jest.fn().mockResolvedValue({ found: false }),
      };

      const withdrawals = {
        findOne: jest.fn(() => Promise.resolve(rows[0] ?? null)),
        save: jest.fn((row: Withdrawal) => Promise.resolve(row)),
        createQueryBuilder: jest.fn(),
      };

      const wallet = {
        balanceOf: jest.fn(),
        append: jest.fn((_m: EntityManager, entries: NewEntry[]) => {
          for (const entry of entries) {
            if (
              !ledger.some((e) => e.idempotencyKey === entry.idempotencyKey)
            ) {
              ledger.push(entry);
            }
          }
          return Promise.resolve(entries.length);
        }),
        withdrawalNet: jest.fn(() =>
          Promise.resolve({ net: net(), count: ledger.length }),
        ),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WithdrawalsService,
          { provide: getRepositoryToken(Withdrawal), useValue: withdrawals },
          { provide: getRepositoryToken(Account), useValue: {} },
          { provide: WalletService, useValue: wallet },
          { provide: PaymentsService, useValue: payments },
          { provide: EmailService, useValue: { sendEmail: jest.fn() } },
          { provide: EventEmitter2, useValue: { emit: jest.fn() } },
          {
            provide: ConfigService,
            useValue: { get: jest.fn().mockReturnValue(8) },
          },
          {
            provide: DataSource,
            useValue: {
              transaction: (work: (m: EntityManager) => Promise<unknown>) =>
                work({
                  update: jest.fn(),
                  query: jest.fn(),
                } as unknown as EntityManager),
            },
          },
        ],
      }).compile();

      service = module.get(WithdrawalsService);
    });

    it('retries on the same reference when Paystack has nothing under it', async () => {
      rows = [withdrawal()];

      await service.retryNow('w1');

      expect(payments.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ reference: 'WDR-ABC' }),
      );
    });

    it('does not send again when Paystack already has the transfer', async () => {
      rows = [withdrawal()];
      payments.verifyTransfer.mockResolvedValue(found('success'));

      const result = await service.retryNow('w1');

      expect(payments.initiateTransfer).not.toHaveBeenCalled();
      expect(result.status).toBe(WithdrawalStatus.SETTLED);
      expect(net()).toBe(-4800);
    });

    it('refuses to retry something already settled', async () => {
      rows = [withdrawal({ status: WithdrawalStatus.SETTLED })];

      await expect(service.retryNow('w1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(payments.initiateTransfer).not.toHaveBeenCalled();
    });

    it('refuses to retry one already refunded, which would pay it twice', async () => {
      rows = [withdrawal({ status: WithdrawalStatus.FAILED })];

      await expect(service.retryNow('w1')).rejects.toThrow(/Check Paystack/);
      expect(payments.initiateTransfer).not.toHaveBeenCalled();
    });

    it('404s rather than silently doing nothing', async () => {
      rows = [];

      await expect(service.retryNow('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('gives up on one by hand once Paystack confirms it never had it', async () => {
      rows = [withdrawal()];

      const result = await service.abandon(
        'w1',
        'Rider paid the vendor in cash',
      );

      expect(result.status).toBe(WithdrawalStatus.FAILED);
      expect(result.failureReason).toBe('Rider paid the vendor in cash');
      expect(net()).toBe(0);
    });

    it('will not refund one Paystack is still sending', async () => {
      rows = [withdrawal()];
      payments.verifyTransfer.mockResolvedValue(found('pending'));

      await expect(service.abandon('w1', 'Taking too long')).rejects.toThrow(
        /still sending/,
      );
      expect(net()).toBe(-4800);
    });

    it('settles instead of refunding one Paystack paid', async () => {
      rows = [withdrawal()];
      payments.verifyTransfer.mockResolvedValue(found('success'));

      const result = await service.abandon('w1', 'Vendor says not received');

      expect(result.status).toBe(WithdrawalStatus.SETTLED);
      expect(net()).toBe(-4800);
    });

    it('changes nothing when Paystack cannot be reached', async () => {
      rows = [withdrawal()];
      payments.verifyTransfer.mockRejectedValue(new Error('timeout'));

      await expect(service.abandon('w1', 'Taking too long')).rejects.toThrow(
        /nothing was changed/,
      );
      expect(rows[0].status).toBe(WithdrawalStatus.PROCESSING);
      expect(net()).toBe(-4800);
    });

    it('settles a refunded withdrawal Paystack paid, taking the refund back', async () => {
      // The production case: refunded on a misread refusal, but the money reached the bank.
      refunded();
      rows = [withdrawal({ status: WithdrawalStatus.FAILED })];
      payments.verifyTransfer.mockResolvedValue(found('success'));

      const result = await service.verifyNow('w1');

      expect(result.status).toBe(WithdrawalStatus.SETTLED);
      expect(net()).toBe(-4800);
      expect(payments.initiateTransfer).not.toHaveBeenCalled();
    });

    it('leaves a refund alone when Paystack never had the transfer', async () => {
      refunded();
      rows = [withdrawal({ status: WithdrawalStatus.FAILED })];

      const result = await service.verifyNow('w1');

      expect(result.status).toBe(WithdrawalStatus.FAILED);
      expect(net()).toBe(0);
      expect(payments.initiateTransfer).not.toHaveBeenCalled();
    });
  });
});
