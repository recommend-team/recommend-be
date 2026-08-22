import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { OrdersService } from './orders.service';
import { Checkout } from './entities/checkout.entity';
import { OrderStatus } from '../../common/enums/order-status.enum';

describe('PaymentReconciliationService', () => {
  let service: PaymentReconciliationService;
  let checkouts: { find: jest.Mock; findOne: jest.Mock };
  let orders: { confirmByReference: jest.Mock };
  let runner: { connect: jest.Mock; query: jest.Mock; release: jest.Mock };
  /** What the row looks like when re-read after confirmByReference. */
  let settledAs: OrderStatus;

  beforeEach(async () => {
    settledAs = OrderStatus.PENDING_PAYMENT;

    checkouts = {
      find: jest.fn().mockResolvedValue([
        { id: 'c1', reference: 'REC-AAA' },
        { id: 'c2', reference: 'REC-BBB' },
      ]),
      findOne: jest.fn(() => Promise.resolve({ status: settledAs })),
    };
    orders = { confirmByReference: jest.fn().mockResolvedValue(undefined) };

    runner = {
      connect: jest.fn().mockResolvedValue(undefined),
      // The lock is taken unless a test says otherwise.
      query: jest.fn().mockResolvedValue([{ locked: true }]),
      release: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentReconciliationService,
        { provide: getRepositoryToken(Checkout), useValue: checkouts },
        { provide: OrdersService, useValue: orders },
        {
          provide: DataSource,
          useValue: { createQueryRunner: () => runner },
        },
      ],
    }).compile();

    service = module.get(PaymentReconciliationService);
  });

  it('asks Paystack about every checkout still waiting to be paid', async () => {
    await service.sweep();

    expect(orders.confirmByReference).toHaveBeenCalledWith('REC-AAA');
    expect(orders.confirmByReference).toHaveBeenCalledWith('REC-BBB');
  });

  it('only looks at orders old enough to have missed their own confirmation', async () => {
    await service.sweep();

    // `mock.calls` is any[][]; naming the shape once keeps the indexing typed.
    const calls = checkouts.find.mock.calls as [
      {
        where: {
          status: OrderStatus;
          createdAt: { value: [Date, Date] } | Date[];
        };
      },
    ][];
    const where = calls[0][0].where;
    expect(where.status).toBe(OrderStatus.PENDING_PAYMENT);

    // Between(oldest, newest) — the newest edge is the grace period, so an order placed
    // seconds ago is left to the buyer's own app rather than raced.
    const [oldest, newest] = (where.createdAt as { value: [Date, Date] })
      .value ?? [new Date(), new Date()];
    const minutesAgo = (Date.now() - newest.getTime()) / 60_000;
    const hoursAgo = (Date.now() - oldest.getTime()) / 3_600_000;

    expect(minutesAgo).toBeGreaterThanOrEqual(9.9);
    expect(hoursAgo).toBeGreaterThanOrEqual(11.9);
  });

  it('does nothing when another instance already holds the lock', async () => {
    runner.query.mockResolvedValue([{ locked: false }]);

    await service.sweep();

    expect(checkouts.find).not.toHaveBeenCalled();
    expect(orders.confirmByReference).not.toHaveBeenCalled();
  });

  it('always releases the lock and the connection, even when the sweep throws', async () => {
    checkouts.find.mockRejectedValue(new Error('db down'));

    await expect(service.sweep()).resolves.toBeUndefined();

    expect(runner.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_unlock($1)',
      expect.any(Array),
    );
    expect(runner.release).toHaveBeenCalled();
  });

  it('keeps going when one order cannot be checked', async () => {
    orders.confirmByReference.mockRejectedValueOnce(new Error('gateway down'));

    await service.sweep();

    // The second order is still checked — one unreachable call must not abandon a batch.
    expect(orders.confirmByReference).toHaveBeenCalledTimes(2);
    expect(orders.confirmByReference).toHaveBeenLastCalledWith('REC-BBB');
  });

  it('never lets the scheduler die on a failure', async () => {
    runner.connect.mockRejectedValue(new Error('no connection'));

    await expect(service.sweep()).resolves.toBeUndefined();
  });
});
