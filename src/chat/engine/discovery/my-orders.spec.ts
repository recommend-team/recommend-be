import type { BuyerOrderSummary } from '../../ports/ordering.port';
import { describeLatestOrder, orderForModel, orderProgress } from './my-orders';
import { emptyHarvest, executeTool } from './tools';

const order = (over: Partial<BuyerOrderSummary> = {}): BuyerOrderSummary => ({
  reference: 'REC-1A2B',
  status: 'PAID',
  createdAt: '2026-10-10T09:00:00.000Z',
  paidAt: '2026-10-10T09:01:00.000Z',
  fulfillmentType: 'DELIVERY',
  deliveryAddress: '12 Herbert Macaulay Way, Yaba',
  goodsTotal: 4100,
  deliveryFee: 1500,
  totalAmount: 5600,
  canComplete: false,
  handoverCode: null,
  rider: null,
  vendors: [
    {
      vendorName: "Mama's Kitchen",
      pickupAddress: null,
      status: 'PAID',
      items: [{ name: 'Jollof Rice', quantity: 2, lineTotal: 4100 }],
    },
  ],
  ...over,
});

describe("the buyer's own orders", () => {
  describe('progress, in words', () => {
    it.each([
      [{ status: 'PENDING_PAYMENT' }, 'not paid yet'],
      [{ status: 'PAID' }, 'paid — the vendor is preparing it'],
      [{ status: 'READY' }, 'ready — waiting for a rider to pick it up'],
      [{ status: 'READY', fulfillmentType: 'PICKUP' }, 'ready to collect'],
      [
        { status: 'DISPATCHED', rider: { name: 'Tunde Bakare', phone: null } },
        'on its way with Tunde',
      ],
      [{ status: 'COMPLETED' }, 'delivered'],
      [{ status: 'COMPLETED', fulfillmentType: 'PICKUP' }, 'collected'],
    ])('%o reads "%s"', (over, expected) => {
      expect(orderProgress(order(over))).toBe(expected);
    });
  });

  it('shows the model the code and where to collect, but only the rider’s first name', () => {
    const shown = orderForModel(
      order({
        status: 'DISPATCHED',
        handoverCode: '4821',
        rider: { name: 'Tunde Bakare', phone: '+2348000000000' },
      }),
    );

    expect(shown).toMatchObject({
      reference: 'REC-1A2B',
      progress: 'on its way with Tunde',
      rider: 'Tunde',
      code: '4821',
    });
    expect(JSON.stringify(shown)).not.toContain('+2348000000000');
  });

  describe('"where is my order?" without a model', () => {
    it('says where the latest one is, and how to hand over the code', () => {
      const text = describeLatestOrder([
        order({ status: 'DISPATCHED', handoverCode: '4821' }),
      ]);

      expect(text).toContain('REC-1A2B, is on its way');
      expect(text).toContain('read them the code in your Orders tab');
    });

    it('points a buyer with no orders here to signing in', () => {
      expect(describeLatestOrder([])).toMatch(/sign in from the menu/);
    });
  });

  describe('get_my_orders', () => {
    const tool = (references: string[], listOrders: jest.Mock) => {
      const harvest = emptyHarvest();
      const result = executeTool(
        'get_my_orders',
        {},
        {
          catalog: {} as never,
          locations: {} as never,
          areaId: null,
          orders: { port: { listOrders } as never, references },
        },
        harvest,
      );
      return { harvest, result };
    };

    it("looks up only this conversation's orders", async () => {
      const listOrders = jest.fn().mockResolvedValue([order()]);

      const { result } = tool(['REC-1A2B'], listOrders);
      const output = await result;

      expect(listOrders).toHaveBeenCalledWith(['REC-1A2B']);
      expect(output).toContain('REC-1A2B');
    });

    it('allows their own totals past the price guard', async () => {
      const { harvest, result } = tool(
        ['REC-1A2B'],
        jest.fn().mockResolvedValue([order()]),
      );
      await result;

      expect(harvest.prices).toEqual(
        expect.arrayContaining([5600, 1500, 4100]),
      );
    });

    it('asks nothing of the database for a buyer with no orders', async () => {
      const listOrders = jest.fn();

      const output = await tool([], listOrders).result;

      expect(listOrders).not.toHaveBeenCalled();
      expect(output).toMatch(/no orders on this device/);
    });

    it('is not a search, so an empty answer is not "found nothing"', async () => {
      const { harvest, result } = tool([], jest.fn());
      await result;

      expect(harvest.searched).toBe(false);
    });
  });
});
