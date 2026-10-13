import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrdersService } from './orders.service';
import { Order } from './entities/order.entity';
import { Checkout } from './entities/checkout.entity';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';
import { PaymentsService } from '../payments/payments.service';

const checkoutWith = (over: Partial<Checkout> = {}): Checkout =>
  ({
    id: 'ck1',
    reference: 'REC-AAA',
    buyerName: 'Ada Obi',
    buyerPhone: '+2348012345678',
    fulfillmentType: FulfillmentType.DELIVERY,
    status: OrderStatus.DISPATCHED,
    deliveryCode: 'KDPXRM',
    goodsTotal: 7000,
    deliveryFee: 1500,
    totalAmount: 8500,
    paidAt: new Date(),
    createdAt: new Date(),
    orders: [
      {
        status: OrderStatus.READY,
        items: [{ productName: 'Jollof Rice', quantity: 1, unitPrice: 3500 }],
      },
    ],
    ...over,
  }) as unknown as Checkout;

describe('OrdersService', () => {
  let service: OrdersService;
  let checkouts: { findOne: jest.Mock };
  let manager: { update: jest.Mock };
  let payments: { verifyTransaction: jest.Mock };

  beforeEach(async () => {
    checkouts = { findOne: jest.fn() };
    manager = { update: jest.fn() };
    payments = { verifyTransaction: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        {
          provide: getRepositoryToken(Order),
          useValue: { findOne: jest.fn() },
        },
        { provide: getRepositoryToken(Checkout), useValue: checkouts },
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn((work: (m: typeof manager) => unknown) =>
              work(manager),
            ),
          },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: PaymentsService, useValue: payments },
      ],
    }).compile();

    service = module.get(OrdersService);
  });

  /**
   * The buyer's own view of their order, and — for anyone who ordered from the storefront
   * rather than the chat — the only place their delivery code exists.
   */
  describe('the public order status', () => {
    it('shows the delivery code while the order is with a rider', async () => {
      checkouts.findOne.mockResolvedValue(checkoutWith());

      const status = await service.getCheckoutStatus('REC-AAA');

      expect(status.deliveryCode).toBe('KDPXRM');
    });

    it('withholds it before dispatch', async () => {
      // Nothing to check yet, and a code shown early is a code screenshotted early.
      checkouts.findOne.mockResolvedValue(
        checkoutWith({ status: OrderStatus.READY, deliveryCode: null }),
      );

      const status = await service.getCheckoutStatus('REC-AAA');

      expect(status.deliveryCode).toBeNull();
    });

    it('withholds it once the order has been delivered', async () => {
      // The column keeps the code for support; the buyer's view does not, because there
      // is nobody left at the door to check it.
      checkouts.findOne.mockResolvedValue(
        checkoutWith({ status: OrderStatus.COMPLETED }),
      );

      const status = await service.getCheckoutStatus('REC-AAA');

      expect(status.deliveryCode).toBeNull();
    });

    it('says nothing about an order that does not exist', async () => {
      checkouts.findOne.mockResolvedValue(null);

      await expect(service.getCheckoutStatus('REC-NOPE')).rejects.toThrow(
        /not found/i,
      );
    });
  });

  /**
   * Every signal that a payment happened — the webhook, the buyer's verify, the sweep —
   * ends in handlePaymentSuccess, so the shortfall check there covers all of them.
   */
  describe('marking a checkout paid', () => {
    const pending = () =>
      checkoutWith({ status: OrderStatus.PENDING_PAYMENT, paidAt: null });

    it('marks it paid when the full amount arrived', async () => {
      checkouts.findOne.mockResolvedValue(pending());

      await service.handlePaymentSuccess('REC-AAA', 8500);

      expect(manager.update).toHaveBeenCalledWith(
        Checkout,
        { id: 'ck1' },
        expect.objectContaining({ status: OrderStatus.PAID }),
      );
    });

    it('refuses a webhook reporting less than the checkout is owed', async () => {
      checkouts.findOne.mockResolvedValue(pending());

      await service.handlePaymentSuccess('REC-AAA', 1000);

      expect(manager.update).not.toHaveBeenCalled();
    });

    it('treats an amount Paystack did not report as no shortfall', async () => {
      checkouts.findOne.mockResolvedValue(pending());

      await service.handlePaymentSuccess('REC-AAA');

      expect(manager.update).toHaveBeenCalled();
    });

    it('refuses a verified payment for less than is owed', async () => {
      checkouts.findOne.mockResolvedValue(pending());
      payments.verifyTransaction.mockResolvedValue({
        status: 'success',
        amountNgn: 8000,
        paidAt: new Date(),
      });

      await service.confirmByReference('REC-AAA');

      expect(manager.update).not.toHaveBeenCalled();
    });
  });
});
