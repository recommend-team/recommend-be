import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { WalletService, NewEntry } from './wallet.service';
import { WalletEntry, WalletEntryType } from './entities/wallet-entry.entity';
import { VendorOrderCompletedEvent } from '../../common/events/vendor-order-completed.event';

const completed = (over: Partial<VendorOrderCompletedEvent> = {}) =>
  ({
    orderId: 'o1',
    checkoutId: 'ck1',
    vendorId: 'v1',
    reference: 'REC-AAA',
    subtotal: 6000,
    platformFee: 1200,
    vendorAmount: 4800,
    ...over,
  }) as VendorOrderCompletedEvent;

/**
 * A stand-in for the unique index, which is where idempotency actually lives. Rows whose
 * key is already present are dropped, exactly as `ON CONFLICT DO NOTHING` drops them.
 */
class FakeLedger {
  readonly rows: NewEntry[] = [];

  insert(values: NewEntry[]): { identifiers: ({ id: string } | undefined)[] } {
    return {
      identifiers: values.map((value) => {
        if (this.rows.some((r) => r.idempotencyKey === value.idempotencyKey)) {
          return undefined;
        }
        this.rows.push(value);
        return { id: `e${this.rows.length}` };
      }),
    };
  }

  balance(userId: string): number {
    return this.rows
      .filter((r) => r.userId === userId)
      .reduce((sum, r) => sum + r.amount, 0);
  }
}

describe('WalletService', () => {
  let service: WalletService;
  let ledger: FakeLedger;
  let repository: { createQueryBuilder: jest.Mock; findAndCount: jest.Mock };

  beforeEach(async () => {
    ledger = new FakeLedger();

    const insertBuilder = {
      insert: () => insertBuilder,
      into: () => insertBuilder,
      values: (values: NewEntry[]) => {
        insertBuilder.pending = values;
        return insertBuilder;
      },
      orIgnore: () => insertBuilder,
      execute: () => Promise.resolve(ledger.insert(insertBuilder.pending)),
      pending: [] as NewEntry[],
    };

    const manager = { createQueryBuilder: () => insertBuilder };

    interface SumBuilder {
      select: () => SumBuilder;
      addSelect: () => SumBuilder;
      where: (
        sql: string,
        params: { userId: string },
      ) => { getRawOne: () => Promise<{ balance: string; count: string }> };
    }

    const sumBuilder: SumBuilder = {
      select: () => sumBuilder,
      addSelect: () => sumBuilder,
      where: (_sql, params) => ({
        getRawOne: () =>
          Promise.resolve({
            balance: String(ledger.balance(params.userId)),
            count: String(
              ledger.rows.filter((r) => r.userId === params.userId).length,
            ),
          }),
      }),
    };

    repository = {
      createQueryBuilder: jest.fn(() => sumBuilder),
      findAndCount: jest.fn(() => Promise.resolve([[], 0])),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: getRepositoryToken(WalletEntry), useValue: repository },
        {
          provide: DataSource,
          useValue: {
            transaction: (work: (m: unknown) => Promise<unknown>) =>
              work(manager),
          },
        },
      ],
    }).compile();

    service = module.get(WalletService);
  });

  describe('crediting a delivered order', () => {
    it('writes the sale and the commission as two entries', async () => {
      await service.creditEarning(completed());

      expect(ledger.rows).toHaveLength(2);
      expect(ledger.rows[0]).toMatchObject({
        type: WalletEntryType.EARNING,
        amount: 6000,
        idempotencyKey: 'earning:o1',
        orderId: 'o1',
      });
      expect(ledger.rows[1]).toMatchObject({
        type: WalletEntryType.COMMISSION,
        amount: -1200,
        idempotencyKey: 'commission:o1',
      });
    });

    it('leaves the vendor with exactly what the order said they were owed', async () => {
      await service.creditEarning(completed());

      expect(await service.balanceOf('v1')).toBe(4800);
    });

    it('debits the commission rather than crediting it', async () => {
      // A positive commission would double the vendor's money instead of taking our cut.
      await service.creditEarning(completed());

      const commission = ledger.rows.find(
        (r) => r.type === WalletEntryType.COMMISSION,
      );
      expect(commission?.amount).toBeLessThan(0);
    });

    it('credits from the order, not from a rate — so an old order keeps its old split', async () => {
      // 15% at the time of sale, whatever the platform charges today.
      await service.creditEarning(
        completed({ subtotal: 6000, platformFee: 900, vendorAmount: 5100 }),
      );

      expect(await service.balanceOf('v1')).toBe(5100);
    });
  });

  describe('the same completion arriving twice', () => {
    it('changes no number', async () => {
      await service.creditEarning(completed());
      const first = await service.balanceOf('v1');

      await service.creditEarning(completed());

      expect(await service.balanceOf('v1')).toBe(first);
    });

    it('writes no further rows', async () => {
      await service.creditEarning(completed());
      await service.creditEarning(completed());
      await service.creditEarning(completed());

      expect(ledger.rows).toHaveLength(2);
    });

    it('reports that it wrote nothing the second time', async () => {
      await expect(service.creditEarning(completed())).resolves.toBe(2);
      await expect(service.creditEarning(completed())).resolves.toBe(0);
    });

    it('still credits a different order for the same vendor', async () => {
      // The key is per order, not per vendor — two sales must both land.
      await service.creditEarning(completed());
      await service.creditEarning(completed({ orderId: 'o2' }));

      expect(await service.balanceOf('v1')).toBe(9600);
    });
  });

  describe('balances', () => {
    it('is zero for a vendor who has sold nothing', async () => {
      expect(await service.balanceOf('nobody')).toBe(0);
    });

    it('keeps one vendor out of another vendor s ledger', async () => {
      await service.creditEarning(completed());
      await service.creditEarning(
        completed({ orderId: 'o2', vendorId: 'v2', vendorAmount: 4800 }),
      );

      expect(await service.balanceOf('v1')).toBe(4800);
      expect(await service.balanceOf('v2')).toBe(4800);
    });

    it('sums many orders rather than storing a running total', async () => {
      for (let i = 1; i <= 5; i++) {
        await service.creditEarning(completed({ orderId: `o${i}` }));
      }

      expect(await service.balanceOf('v1')).toBe(24000);
      expect(await service.summaryOf('v1')).toEqual({
        balance: 24000,
        entryCount: 10,
      });
    });
  });
});
