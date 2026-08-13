import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderLifecycleService } from './order-lifecycle.service';
import { Order } from './entities/order.entity';
import { Checkout } from './entities/checkout.entity';
import { StatusActor } from './entities/order-status-event.entity';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';
import { CHECKOUT_STATUS_CHANGED_EVENT } from '../../common/events/checkout-status-changed.event';
import {
  VENDOR_ORDER_COMPLETED_EVENT,
  VendorOrderCompletedEvent,
} from '../../common/events/vendor-order-completed.event';

/** A checkout with two vendors, which is where all the interesting cases live. */
const checkoutWith = (
  over: Partial<Checkout> = {},
  orderStatuses: OrderStatus[] = [OrderStatus.PAID, OrderStatus.PAID],
): Checkout =>
  ({
    id: 'ck1',
    reference: 'REC-AAA',
    buyerName: 'Ada Obi',
    buyerPhone: '+2348012345678',
    fulfillmentType: FulfillmentType.DELIVERY,
    status: OrderStatus.PAID,
    goodsTotal: 7000,
    deliveryFee: 1500,
    totalAmount: 8500,
    createdAt: new Date(),
    orders: orderStatuses.map((status, index) => ({
      id: `o${index + 1}`,
      checkoutId: 'ck1',
      vendorId: `v${index + 1}`,
      status,
      // Written at checkout and never recomputed — the wallet credits from these.
      totalAmount: 3500,
      platformFee: 700,
      vendorAmount: 2800,
      items: [{ productName: 'Jollof Rice', quantity: 1 }],
      vendor: { businessName: `Vendor ${index + 1}` },
    })),
    ...over,
  }) as unknown as Checkout;

describe('OrderLifecycleService', () => {
  let service: OrderLifecycleService;
  let orders: { findOne: jest.Mock };
  let checkouts: { findOne: jest.Mock };
  let manager: { update: jest.Mock; insert: jest.Mock; findOne: jest.Mock };
  let emitter: { emit: jest.Mock };
  /** What `recomputeCheckout` re-reads mid-transaction. */
  let refreshed: Checkout | null;

  beforeEach(async () => {
    refreshed = null;
    orders = { findOne: jest.fn() };
    checkouts = { findOne: jest.fn() };
    manager = {
      update: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(() => Promise.resolve(refreshed)),
    };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderLifecycleService,
        { provide: getRepositoryToken(Order), useValue: orders },
        { provide: getRepositoryToken(Checkout), useValue: checkouts },
        {
          provide: DataSource,
          useValue: {
            transaction: (work: (m: unknown) => Promise<void>) => work(manager),
          },
        },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    service = module.get(OrderLifecycleService);
  });

  const auditRows = () =>
    manager.insert.mock.calls.map(([, row]) => row as Record<string, unknown>);

  describe('a vendor marking ready', () => {
    it('refuses an order belonging to another vendor', async () => {
      orders.findOne.mockResolvedValue({
        id: 'o1',
        vendorId: 'someone-else',
        status: OrderStatus.PAID,
        checkoutId: 'ck1',
      });

      await expect(service.markReady('o1', 'v1')).rejects.toThrow(
        /another vendor/i,
      );
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('refuses an order that has not been paid for', async () => {
      orders.findOne.mockResolvedValue({
        id: 'o1',
        vendorId: 'v1',
        status: OrderStatus.PENDING_PAYMENT,
        checkoutId: 'ck1',
      });

      await expect(service.markReady('o1', 'v1')).rejects.toThrow(/paid/i);
    });

    it('does not move the checkout while another vendor is still cooking', async () => {
      orders.findOne.mockResolvedValue({
        id: 'o1',
        vendorId: 'v1',
        status: OrderStatus.PAID,
        checkoutId: 'ck1',
      });
      // Vendor 1 is now ready; vendor 2 is not.
      refreshed = checkoutWith({}, [OrderStatus.READY, OrderStatus.PAID]);

      await service.markReady('o1', 'v1');

      // The order moved...
      expect(auditRows().some((row) => row.orderId === 'o1')).toBe(true);
      // ...but the buyer heard nothing, because their order has not moved.
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('moves the checkout once every vendor is ready', async () => {
      orders.findOne.mockResolvedValue({
        id: 'o2',
        vendorId: 'v2',
        status: OrderStatus.PAID,
        checkoutId: 'ck1',
      });
      refreshed = checkoutWith({}, [OrderStatus.READY, OrderStatus.READY]);

      await service.markReady('o2', 'v2');

      expect(emitter.emit).toHaveBeenCalledWith(
        CHECKOUT_STATUS_CHANGED_EVENT,
        expect.objectContaining({ to: OrderStatus.READY }),
      );
      // Derived, so nobody pressed a button for it.
      expect(
        auditRows().some(
          (row) =>
            row.checkoutId === 'ck1' &&
            row.toStatus === OrderStatus.READY &&
            row.actorType === StatusActor.SYSTEM,
        ),
      ).toBe(true);
    });

    it('is idempotent — a second tap changes nothing', async () => {
      orders.findOne.mockResolvedValue({
        id: 'o1',
        vendorId: 'v1',
        status: OrderStatus.READY,
        checkoutId: 'ck1',
      });

      await service.markReady('o1', 'v1');

      expect(manager.update).not.toHaveBeenCalled();
    });
  });

  describe('dispatch', () => {
    it('refuses until every vendor is ready', async () => {
      checkouts.findOne.mockResolvedValue(
        checkoutWith({ status: OrderStatus.PAID }),
      );

      await expect(
        service.markDispatched('REC-AAA', {
          type: StatusActor.ADMIN,
          id: 'a1',
        }),
      ).rejects.toThrow(/ready/i);
    });

    it('refuses on a pickup order, which is never dispatched', async () => {
      checkouts.findOne.mockResolvedValue(
        checkoutWith({
          status: OrderStatus.READY,
          fulfillmentType: FulfillmentType.PICKUP,
        }),
      );

      await expect(
        service.markDispatched('REC-AAA', {
          type: StatusActor.ADMIN,
          id: 'a1',
        }),
      ).rejects.toThrow(/pickup/i);
    });

    it('announces the one message a buyer actually gets', async () => {
      checkouts.findOne.mockResolvedValue(
        checkoutWith({ status: OrderStatus.READY }),
      );

      await service.markDispatched('REC-AAA', {
        type: StatusActor.ADMIN,
        id: 'a1',
      });

      expect(emitter.emit).toHaveBeenCalledWith(
        CHECKOUT_STATUS_CHANGED_EVENT,
        expect.objectContaining({
          from: OrderStatus.READY,
          to: OrderStatus.DISPATCHED,
          buyerName: 'Ada Obi',
        }),
      );
    });
  });

  describe('completion', () => {
    it('takes the vendor orders with it, so payout reporting agrees', async () => {
      checkouts.findOne.mockResolvedValue(
        checkoutWith({ status: OrderStatus.DISPATCHED }),
      );

      await service.markCompleted('REC-AAA', {
        type: StatusActor.BUYER,
        id: null,
      });

      const completed = auditRows().filter(
        (row) => row.toStatus === OrderStatus.COMPLETED,
      );
      // One for the checkout, one for each vendor order.
      expect(completed).toHaveLength(3);
      expect(completed.filter((row) => row.orderId)).toHaveLength(2);
    });

    it('records the buyer as the actor with no user id', async () => {
      checkouts.findOne.mockResolvedValue(
        checkoutWith({ status: OrderStatus.DISPATCHED }),
      );

      await service.markCompleted('REC-AAA', {
        type: StatusActor.BUYER,
        id: null,
      });

      // A buyer has no account; claiming otherwise in an audit trail would be a lie.
      expect(auditRows()[0]).toMatchObject({
        actorType: StatusActor.BUYER,
        actorId: null,
      });
    });

    it('refuses to complete something nobody paid for', async () => {
      checkouts.findOne.mockResolvedValue(
        checkoutWith({ status: OrderStatus.PENDING_PAYMENT }),
      );

      await expect(
        service.markCompleted('REC-AAA', { type: StatusActor.BUYER, id: null }),
      ).rejects.toThrow(/paid/i);
    });
  });

  describe('what the wallet is told', () => {
    const earnings = () =>
      emitter.emit.mock.calls
        .filter(([name]) => name === VENDOR_ORDER_COMPLETED_EVENT)
        .map(([, payload]) => payload as VendorOrderCompletedEvent);

    it('announces one earning per vendor, carrying the figures on the row', async () => {
      checkouts.findOne.mockResolvedValue(
        checkoutWith({ status: OrderStatus.DISPATCHED }),
      );

      await service.markCompleted('REC-AAA', {
        type: StatusActor.BUYER,
        id: null,
      });

      expect(earnings()).toHaveLength(2);
      expect(earnings()[0]).toMatchObject({
        orderId: 'o1',
        vendorId: 'v1',
        reference: 'REC-AAA',
        subtotal: 3500,
        platformFee: 700,
        vendorAmount: 2800,
      });
    });

    it('says nothing about a vendor already completed', async () => {
      // Re-completing must not pay twice. The ledger key would catch it anyway; not
      // announcing it at all means the question never reaches the ledger.
      checkouts.findOne.mockResolvedValue(
        checkoutWith({ status: OrderStatus.DISPATCHED }, [
          OrderStatus.COMPLETED,
          OrderStatus.PAID,
        ]),
      );

      await service.markCompleted('REC-AAA', {
        type: StatusActor.BUYER,
        id: null,
      });

      expect(earnings().map((e) => e.orderId)).toEqual(['o2']);
    });

    it('stays silent when a vendor merely marks ready', async () => {
      orders.findOne.mockResolvedValue({
        id: 'o1',
        vendorId: 'v1',
        status: OrderStatus.PAID,
        checkoutId: 'ck1',
      });
      refreshed = checkoutWith({}, [OrderStatus.READY, OrderStatus.READY]);

      await service.markReady('o1', 'v1');

      expect(earnings()).toHaveLength(0);
    });

    it('credits nobody when an admin cancels', async () => {
      checkouts.findOne.mockResolvedValue(
        checkoutWith({ status: OrderStatus.PAID }),
      );

      await service.overrideCheckout(
        'REC-AAA',
        OrderStatus.CANCELLED,
        'admin-1',
      );

      expect(earnings()).toHaveLength(0);
    });

    it('publishes only after the transaction commits', async () => {
      // A listener firing mid-transaction would credit against rows that may still roll
      // back, and on its own connection it cannot see them anyway.
      const order: string[] = [];
      manager.insert.mockImplementation(() => {
        order.push('write');
        return Promise.resolve(undefined);
      });
      emitter.emit.mockImplementation(() => {
        order.push('emit');
        return true;
      });
      checkouts.findOne.mockResolvedValue(
        checkoutWith({ status: OrderStatus.DISPATCHED }),
      );

      await service.markCompleted('REC-AAA', {
        type: StatusActor.BUYER,
        id: null,
      });

      expect(order.lastIndexOf('write')).toBeLessThan(order.indexOf('emit'));
    });
  });

  describe('admin override', () => {
    it('ignores the transition rules, because that is what it is for', async () => {
      // Straight from paid to completed — no ready, no dispatch. A delivery sorted out
      // over the phone still has to be recordable.
      checkouts.findOne.mockResolvedValue(
        checkoutWith({ status: OrderStatus.PAID }),
      );

      await service.overrideCheckout(
        'REC-AAA',
        OrderStatus.COMPLETED,
        'admin-1',
        'Rider confirmed by phone',
      );

      expect(auditRows()[0]).toMatchObject({
        fromStatus: OrderStatus.PAID,
        toStatus: OrderStatus.COMPLETED,
        actorType: StatusActor.ADMIN,
        actorId: 'admin-1',
        note: 'Rider confirmed by phone',
      });
    });

    it('leaves vendor orders alone for a mid-lifecycle correction', async () => {
      checkouts.findOne.mockResolvedValue(
        checkoutWith({ status: OrderStatus.DISPATCHED }),
      );

      await service.overrideCheckout('REC-AAA', OrderStatus.READY, 'admin-1');

      // Pulling the checkout back does not unmake what the vendors actually did.
      expect(auditRows().filter((row) => row.orderId)).toHaveLength(0);
    });
  });
});
