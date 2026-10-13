import { SellersService } from './sellers.service';
import { LocalOrderingAdapter } from '../../chat/adapters/local-ordering.adapter';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';

/**
 * Who sees the assigned rider: the vendor, from assignment (that is who comes to collect),
 * and the buyer, once it is on its way (that is who to call). Never the rider's account.
 */

const rider = {
  id: 'r1',
  firstName: 'Musa',
  lastName: 'Bello',
  phoneNumber: '+2348011111111',
  email: 'musa@example.com',
  password: '$argon2-hash',
};

describe('the vendor sees who is collecting', () => {
  const ordersWith = (checkout: unknown) => ({
    findAndCount: jest
      .fn()
      .mockResolvedValue([
        [{ id: 'o1', status: OrderStatus.READY, items: [], checkout }],
        1,
      ]),
  });

  const listFor = async (checkout: unknown) => {
    const service = new SellersService(
      {} as never,
      ordersWith(checkout) as never,
      {} as never,
    );
    const result = await service.getOrders('v1', {});
    return result.data.items[0].checkout;
  };

  it('shows the assigned rider’s name and phone, and nothing else of theirs', async () => {
    const checkout = await listFor({
      id: 'ck1',
      reference: 'REC-AAA',
      totalAmount: 99999,
      rider,
    });

    expect(checkout).toEqual({
      id: 'ck1',
      reference: 'REC-AAA',
      rider: { name: 'Musa Bello', phone: '+2348011111111' },
    });
  });

  it('shows no rider until one is assigned', async () => {
    const checkout = await listFor({
      id: 'ck1',
      reference: 'REC-AAA',
      rider: null,
    });

    expect(checkout?.rider).toBeNull();
  });
});

describe('the buyer sees who is bringing it', () => {
  const ordersFor = async (status: OrderStatus) => {
    const adapter = new LocalOrderingAdapter(
      {} as never,
      {} as never,
      {
        find: jest.fn().mockResolvedValue([
          {
            reference: 'REC-AAA',
            status,
            fulfillmentType: FulfillmentType.DELIVERY,
            createdAt: new Date(),
            paidAt: new Date(),
            goodsTotal: 7000,
            deliveryFee: 1500,
            totalAmount: 8500,
            deliveryCode: 'ABCDEF',
            rider,
            orders: [],
          },
        ]),
      } as never,
    );
    const [order] = await adapter.listOrders(['REC-AAA']);
    return order;
  };

  it('once it is on its way', async () => {
    expect((await ordersFor(OrderStatus.DISPATCHED)).rider).toEqual({
      name: 'Musa Bello',
      phone: '+2348011111111',
    });
  });

  it.each([OrderStatus.PAID, OrderStatus.READY, OrderStatus.COMPLETED])(
    'not while it is %s',
    async (status) => {
      expect((await ordersFor(status)).rider).toBeNull();
    },
  );
});
