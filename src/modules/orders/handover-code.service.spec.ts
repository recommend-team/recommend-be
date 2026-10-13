import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HandoverCodeService } from './handover-code.service';
import { liveHandoverCode } from './handover-code';
import { Order } from './entities/order.entity';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';

describe('liveHandoverCode', () => {
  const code = 'QWERTY';

  it.each([
    [
      'a pickup waiting at the counter',
      FulfillmentType.PICKUP,
      OrderStatus.READY,
      code,
    ],
    ['a pickup not ready yet', FulfillmentType.PICKUP, OrderStatus.PAID, null],
    [
      'a pickup already collected',
      FulfillmentType.PICKUP,
      OrderStatus.COMPLETED,
      null,
    ],
    [
      'a delivery with the rider',
      FulfillmentType.DELIVERY,
      OrderStatus.DISPATCHED,
      code,
    ],
    [
      'a delivery still at the vendor',
      FulfillmentType.DELIVERY,
      OrderStatus.READY,
      null,
    ],
    [
      'a delivery already delivered',
      FulfillmentType.DELIVERY,
      OrderStatus.COMPLETED,
      null,
    ],
  ])('%s', (_label, fulfillmentType, status, expected) => {
    expect(
      liveHandoverCode({ fulfillmentType, status, deliveryCode: code }),
    ).toBe(expected);
  });
});

describe('HandoverCodeService', () => {
  let service: HandoverCodeService;
  let order: Record<string, unknown> | null;
  let counter: number;
  let redis: { incr: jest.Mock; expire: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    counter = 0;
    order = {
      id: 'o1',
      vendorId: 'v1',
      buyerName: 'Ada Obi',
      fulfillmentType: FulfillmentType.PICKUP,
      checkout: {
        status: OrderStatus.READY,
        fulfillmentType: FulfillmentType.PICKUP,
        deliveryCode: 'QWERTY',
      },
    };
    redis = {
      incr: jest.fn(() => Promise.resolve(++counter)),
      expire: jest.fn(),
      del: jest.fn(() => {
        counter = 0;
        return Promise.resolve(1);
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        HandoverCodeService,
        {
          provide: getRepositoryToken(Order),
          useValue: { findOne: jest.fn(() => Promise.resolve(order)) },
        },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();

    service = module.get(HandoverCodeService);
  });

  it('confirms the right code, and says who should be collecting', async () => {
    await expect(service.check('o1', 'v1', 'QWERTY')).resolves.toMatchObject({
      matches: true,
      buyerName: 'Ada Obi',
    });
  });

  it('forgives case and spaces, as people read codes aloud', async () => {
    await expect(service.check('o1', 'v1', ' qwe rty ')).resolves.toMatchObject(
      {
        matches: true,
      },
    );
  });

  it('says plainly when the code is wrong', async () => {
    await expect(service.check('o1', 'v1', 'ABCDEF')).resolves.toMatchObject({
      matches: false,
      attemptsLeft: 9,
    });
  });

  it('stops answering after ten wrong codes, so a code cannot be guessed', async () => {
    for (let i = 0; i < 10; i++) await service.check('o1', 'v1', 'WRONGG');

    await expect(service.check('o1', 'v1', 'QWERTY')).rejects.toThrow(
      /too many wrong codes/i,
    );
  });

  it('starts the count afresh after a right code', async () => {
    await service.check('o1', 'v1', 'WRONGG');
    await service.check('o1', 'v1', 'QWERTY');

    expect(redis.del).toHaveBeenCalledWith('handover-check:o1');
  });

  it("refuses another vendor's order", async () => {
    await expect(service.check('o1', 'v2', 'QWERTY')).rejects.toThrow(
      /another vendor/i,
    );
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('refuses a delivery — the rider checks that code, not the vendor', async () => {
    order!.fulfillmentType = FulfillmentType.DELIVERY;

    await expect(service.check('o1', 'v1', 'QWERTY')).rejects.toThrow(
      /only pickup orders/i,
    );
  });

  it('refuses an order that is not waiting for collection', async () => {
    (order!.checkout as { status: OrderStatus }).status = OrderStatus.PAID;

    await expect(service.check('o1', 'v1', 'QWERTY')).rejects.toThrow(
      /not waiting for collection/i,
    );
  });

  it('404s an order that does not exist', async () => {
    order = null;

    await expect(service.check('o1', 'v1', 'QWERTY')).rejects.toThrow(
      /not found/i,
    );
  });
});
