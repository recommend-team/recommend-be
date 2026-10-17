import { BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { CheckoutSource } from '../../common/enums/checkout-source.enum';
import type { Checkout } from '../orders/entities/checkout.entity';

const checkout = (over: Partial<Checkout>): Checkout =>
  ({
    id: 'c1',
    reference: 'REC-AAA',
    status: OrderStatus.PAID,
    buyerName: 'Ada',
    buyerPhone: '+2348011111111',
    buyerEmail: 'ada@example.com',
    fulfillmentType: 'DELIVERY',
    deliveryAddress: '1 Road',
    goodsTotal: '3000',
    deliveryFee: '1500',
    totalAmount: '4500',
    paidAt: new Date('2026-10-17T08:00:00Z'),
    createdAt: new Date('2026-10-17T07:59:00Z'),
    deliveryCode: null,
    createdByAdminId: null,
    source: CheckoutSource.CHAT,
    rider: null,
    riderAssignedAt: null,
    orders: [],
    ...over,
  }) as unknown as Checkout;

describe('AdminService — transactions', () => {
  let rows: Checkout[];
  let facts: { id: string; dispatchedAt: Date | null; buyerOnChat: boolean }[];
  let qb: Record<string, jest.Mock>;
  let query: jest.Mock;
  let service: AdminService;

  beforeEach(() => {
    rows = [];
    facts = [];
    qb = {};
    for (const method of [
      'leftJoinAndSelect',
      'leftJoin',
      'addSelect',
      'orderBy',
      'skip',
      'take',
      'andWhere',
    ]) {
      qb[method] = jest.fn(() => qb);
    }
    qb.getManyAndCount = jest.fn(() => Promise.resolve([rows, rows.length]));
    query = jest.fn(() => Promise.resolve(facts));

    service = new AdminService(
      {} as never,
      {} as never,
      {} as never,
      { createQueryBuilder: jest.fn(() => qb), query } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: jest.fn().mockReturnValue(3) } as never,
    );
  });

  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

  it('marks where each order came from and whether the buyer can be reached in the chat', async () => {
    rows = [
      checkout({ id: 'chat' }),
      checkout({ id: 'admin', source: CheckoutSource.ADMIN }),
      checkout({ id: 'shop-in', source: CheckoutSource.STOREFRONT }),
      checkout({ id: 'shop-out', source: CheckoutSource.STOREFRONT }),
    ];
    facts = [
      { id: 'chat', dispatchedAt: null, buyerOnChat: false },
      { id: 'admin', dispatchedAt: null, buyerOnChat: false },
      { id: 'shop-in', dispatchedAt: null, buyerOnChat: true },
      { id: 'shop-out', dispatchedAt: null, buyerOnChat: false },
    ];

    const { items } = await service.getTransactions({});

    expect(
      items.map(({ id, source, buyerOnChat }) => ({ id, source, buyerOnChat })),
    ).toEqual([
      // Placed in a conversation — reachable there whether or not they signed in.
      { id: 'chat', source: CheckoutSource.CHAT, buyerOnChat: true },
      { id: 'admin', source: CheckoutSource.ADMIN, buyerOnChat: true },
      { id: 'shop-in', source: CheckoutSource.STOREFRONT, buyerOnChat: true },
      { id: 'shop-out', source: CheckoutSource.STOREFRONT, buyerOnChat: false },
    ]);
    // One query for the page, not one per row.
    expect(query).toHaveBeenCalledTimes(1);
    expect((query.mock.calls[0] as [string, unknown[]])[1]).toEqual([
      ['chat', 'admin', 'shop-in', 'shop-out'],
    ]);
  });

  it('calls an order stuck once it has been with its rider past the limit', async () => {
    rows = [
      checkout({ id: 'late', status: OrderStatus.DISPATCHED }),
      checkout({ id: 'fresh', status: OrderStatus.DISPATCHED }),
      checkout({ id: 'done', status: OrderStatus.COMPLETED }),
    ];
    facts = [
      { id: 'late', dispatchedAt: hoursAgo(3.5), buyerOnChat: false },
      { id: 'fresh', dispatchedAt: hoursAgo(1), buyerOnChat: false },
      { id: 'done', dispatchedAt: hoursAgo(5), buyerOnChat: false },
    ];

    const { items } = await service.getTransactions({});

    expect(items.map(({ id, stuck }) => ({ id, stuck }))).toEqual([
      { id: 'late', stuck: true },
      { id: 'fresh', stuck: false },
      { id: 'done', stuck: false },
    ]);
    expect(items[0].dispatchedAt).toBe(facts[0].dispatchedAt!.toISOString());
  });

  it('filters by source, and to deliveries stuck on their way', async () => {
    await service.getTransactions({
      source: CheckoutSource.STOREFRONT,
      stuck: true,
    });

    const wheres = qb.andWhere.mock.calls as [
      string,
      Record<string, unknown>?,
    ][];
    expect(wheres).toContainEqual([
      'checkout.source = :source',
      { source: CheckoutSource.STOREFRONT },
    ]);
    expect(wheres).toContainEqual([
      'checkout.status = :dispatched',
      { dispatched: OrderStatus.DISPATCHED },
    ]);
    const stale = wheres.find(([sql]) => sql.includes(':staleCutoff'));
    expect(stale?.[0]).toContain(`e."toStatus" = 'DISPATCHED'`);
    const cutoff = stale?.[1]?.staleCutoff as Date;
    expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(3 * 3_600_000);
  });

  it('refuses a source it does not know', async () => {
    await expect(
      service.getTransactions({ source: 'WHATSAPP' as CheckoutSource }),
    ).rejects.toThrow(BadRequestException);
  });

  it('still lists the page when the follow-up details cannot be read', async () => {
    rows = [checkout({ id: 'shop', source: CheckoutSource.STOREFRONT })];
    query.mockRejectedValueOnce(new Error('too many connections'));

    const { items } = await service.getTransactions({});

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      buyerOnChat: false,
      stuck: false,
      dispatchedAt: null,
    });
  });
});
