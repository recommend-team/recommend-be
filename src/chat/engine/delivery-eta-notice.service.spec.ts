import {
  DeliveryEtaNoticeService,
  ORDER_IS_CLOSE,
} from './delivery-eta-notice.service';
import { LocalOrderingAdapter } from '../adapters/local-ordering.adapter';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';
import { ChatChannel } from '../enums/chat.enums';

describe('telling the buyer their order is close', () => {
  let due: { reference: string }[];
  let claimedRows: unknown[];
  let sent: { address: string; text: string }[];
  let pushed: { conversationId: string; tag: string }[];
  let updateSql: string;
  let service: DeliveryEtaNoticeService;
  let where: string[];

  beforeEach(() => {
    due = [];
    claimedRows = [];
    sent = [];
    pushed = [];
    updateSql = '';
    where = [];

    const builder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn(function (this: unknown, sql: string) {
        where.push(sql);
        return this;
      }),
      andWhere: jest.fn(function (this: unknown, sql: string) {
        where.push(sql);
        return this;
      }),
      getRawMany: jest.fn(() => Promise.resolve(due)),
    };

    service = new DeliveryEtaNoticeService(
      { createQueryBuilder: jest.fn(() => builder) } as never,
      {
        query: jest.fn((sql: string) => {
          updateSql = sql;
          // TypeORM's shape for an UPDATE: [rows, affected].
          return Promise.resolve([claimedRows, claimedRows.length]);
        }),
      } as never,
      {
        recordOutbound: jest.fn(() =>
          Promise.resolve({ id: 'm1', createdAt: new Date() }),
        ),
      } as never,
      {
        send: jest.fn(
          (_channel: string, address: string, message: { text: string }) => {
            sent.push({ address, text: message.text });
            return Promise.resolve();
          },
        ),
      } as never,
      {
        notify: jest.fn((conversationId: string, message: { tag: string }) => {
          pushed.push({ conversationId, tag: message.tag });
          return Promise.resolve();
        }),
      } as never,
      { get: jest.fn(() => 30) } as never,
    );
  });

  it('does nothing when no order is past its time', async () => {
    expect(await service.sendDueNotices()).toBe(0);
    expect(updateSql).toBe('');
    expect(sent).toHaveLength(0);
  });

  it('looks only at paid deliveries not yet received', async () => {
    await service.sendDueNotices();

    expect(where.join(' ')).toMatch(/status IN/);
    expect(where.join(' ')).toMatch(/fulfillmentType = :delivery/);
    expect(where.join(' ')).toMatch(/paidAt <= :cutoff/);
  });

  it('tells each claimed buyer once, in the chat and by push', async () => {
    due = [{ reference: 'REC-1' }];
    claimedRows = [
      {
        id: 'c1',
        channel: ChatChannel.PWA,
        channelAddress: 'session-1',
        reference: 'REC-1',
      },
    ];

    expect(await service.sendDueNotices()).toBe(1);

    expect(sent).toEqual([{ address: 'session-1', text: ORDER_IS_CLOSE }]);
    expect(pushed).toEqual([{ conversationId: 'c1', tag: 'order:REC-1' }]);
  });

  it('claims in the same statement that marks it told, so it is never sent twice', async () => {
    due = [{ reference: 'REC-1' }];

    await service.sendDueNotices();

    // Already marked (an earlier run, another instance): not claimed, not sent.
    expect(updateSql).toMatch(/NOT jsonb_exists\(.*etaNoticeSent/s);
    expect(updateSql).toMatch(/orderReferences/);
    expect(updateSql).toMatch(/"mergedIntoId" IS NULL/);
    expect(sent).toHaveLength(0);
  });
});

describe('the expected delivery time on a buyer order', () => {
  const listWith = async (checkout: Record<string, unknown>, eta?: number) => {
    const adapter = new LocalOrderingAdapter(
      {} as never,
      {} as never,
      {
        find: jest.fn().mockResolvedValue([
          {
            reference: 'REC-AAA',
            createdAt: new Date('2026-10-14T12:00:00.000Z'),
            goodsTotal: 7000,
            deliveryFee: 1500,
            totalAmount: 8500,
            orders: [],
            rider: null,
            ...checkout,
          },
        ]),
      } as never,
      eta === undefined ? undefined : ({ get: () => eta } as never),
    );
    const [order] = await adapter.listOrders(['REC-AAA']);
    return order;
  };

  it('is payment plus the configured minutes', async () => {
    const order = await listWith(
      {
        status: OrderStatus.PAID,
        fulfillmentType: FulfillmentType.DELIVERY,
        paidAt: new Date('2026-10-14T12:05:00.000Z'),
      },
      45,
    );

    expect(order.expectedBy).toBe('2026-10-14T12:50:00.000Z');
    expect(order.etaMinutes).toBe(45);
  });

  it('defaults to 30 minutes', async () => {
    const order = await listWith({
      status: OrderStatus.PAID,
      fulfillmentType: FulfillmentType.DELIVERY,
      paidAt: new Date('2026-10-14T12:05:00.000Z'),
    });

    expect(order.expectedBy).toBe('2026-10-14T12:35:00.000Z');
  });

  it('is not set before payment — an unpaid order is not coming', async () => {
    const order = await listWith({
      status: OrderStatus.PENDING_PAYMENT,
      fulfillmentType: FulfillmentType.DELIVERY,
      paidAt: null,
    });

    expect(order.expectedBy).toBeNull();
  });

  it('is not set for a pickup', async () => {
    const order = await listWith({
      status: OrderStatus.PAID,
      fulfillmentType: FulfillmentType.PICKUP,
      paidAt: new Date('2026-10-14T12:05:00.000Z'),
    });

    expect(order.expectedBy).toBeNull();
  });
});
