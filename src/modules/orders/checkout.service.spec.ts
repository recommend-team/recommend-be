import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConflictException } from '@nestjs/common';
import { CheckoutService } from './checkout.service';
import { Checkout } from './entities/checkout.entity';
import { Product } from '../products/entities/product.entity';
import { PaymentsService } from '../payments/payments.service';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';

const DELIVERY_FEE = 1500;

interface SavedRow {
  id?: string;
  [key: string]: unknown;
}
interface SavedCheckout {
  id: string;
  reference: string;
}
interface SavedOrder {
  id: string;
  vendorId: string;
  totalAmount: number;
  platformFee: number;
  vendorAmount: number;
}
interface SavedItem {
  productName: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

const product = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'Jollof Rice with Chicken',
  price: 3500,
  isAvailable: true,
  vendorId: 'v1',
  vendor: { id: 'v1', status: SellerStatus.APPROVED, isOpen: true },
  ...over,
});

const baseDto = {
  buyerName: 'Ada Obi',
  buyerPhone: '+2348012345678',
  fulfillmentType: FulfillmentType.DELIVERY,
  deliveryAddress: '12 Herbert Macaulay Way, Yaba',
};

describe('CheckoutService', () => {
  let service: CheckoutService;
  let products: { find: jest.Mock };
  let checkouts: { delete: jest.Mock };
  let payments: { initializePayment: jest.Mock };
  /** Rows the transaction would have written, so the money can be asserted. */
  let saved: {
    checkouts: SavedCheckout[];
    orders: SavedOrder[];
    items: SavedItem[];
  };

  beforeEach(async () => {
    saved = { checkouts: [], orders: [], items: [] };
    products = { find: jest.fn().mockResolvedValue([]) };
    checkouts = { delete: jest.fn() };
    payments = {
      initializePayment: jest.fn().mockResolvedValue({
        authorizationUrl: 'https://checkout.paystack.com/abc',
        accessCode: 'abc',
        reference: 'ref',
      }),
    };

    const manager = {
      create: (_entity: unknown, data: Record<string, unknown>) => ({
        ...data,
      }),
      save: (entity: SavedRow | SavedRow[]) => {
        const rows = Array.isArray(entity) ? entity : [entity];
        rows.forEach((row) => {
          if ('reference' in row) {
            row.id = row.id ?? `checkout-${saved.checkouts.length + 1}`;
            saved.checkouts.push(row as unknown as SavedCheckout);
          } else if ('vendorId' in row) {
            row.id = row.id ?? `order-${saved.orders.length + 1}`;
            saved.orders.push(row as unknown as SavedOrder);
          } else {
            saved.items.push(row as unknown as SavedItem);
          }
        });
        return Promise.resolve(entity);
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckoutService,
        { provide: getRepositoryToken(Product), useValue: products },
        { provide: getRepositoryToken(Checkout), useValue: checkouts },
        { provide: PaymentsService, useValue: payments },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(DELIVERY_FEE) },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: (cb: (m: unknown) => Promise<unknown>) => cb(manager),
          },
        },
      ],
    }).compile();

    service = module.get<CheckoutService>(CheckoutService);
  });

  describe('the worked example from the plan', () => {
    beforeEach(() => {
      products.find.mockResolvedValue([
        product({ id: 'jollof', price: 3000, vendorId: 'mamas' }),
        product({
          id: 'yam',
          name: 'Pounded Yam',
          price: 4500,
          vendorId: 'buka',
          vendor: { id: 'buka', status: SellerStatus.APPROVED, isOpen: true },
        }),
      ]);
    });

    it('splits a two-vendor basket into one order each, with independent money', async () => {
      const result = await service.createCheckout({
        ...baseDto,
        items: [
          { productId: 'jollof', quantity: 2 },
          { productId: 'yam', quantity: 1 },
        ],
      } as never);

      expect(result.vendorCount).toBe(2);
      expect(saved.orders).toHaveLength(2);

      const byVendor = (id: string): SavedOrder => {
        const order = saved.orders.find((o) => o.vendorId === id);
        if (!order) throw new Error(`no order for vendor ${id}`);
        return order;
      };

      expect(byVendor('mamas')).toMatchObject({
        totalAmount: 6000,
        platformFee: 1200,
        vendorAmount: 4800,
      });
      expect(byVendor('buka')).toMatchObject({
        totalAmount: 4500,
        platformFee: 900,
        vendorAmount: 3600,
      });
    });

    it('charges the buyer goods plus one delivery fee', async () => {
      const result = await service.createCheckout({
        ...baseDto,
        items: [
          { productId: 'jollof', quantity: 2 },
          { productId: 'yam', quantity: 1 },
        ],
      } as never);

      expect(result.goodsTotal).toBe(10500);
      expect(result.deliveryFee).toBe(1500);
      expect(result.totalAmount).toBe(12000);
    });

    it('reconciles: vendor payouts plus platform take equals what was charged', async () => {
      const result = await service.createCheckout({
        ...baseDto,
        items: [
          { productId: 'jollof', quantity: 2 },
          { productId: 'yam', quantity: 1 },
        ],
      } as never);

      const payouts = saved.orders.reduce((s, o) => s + o.vendorAmount, 0);
      const fees = saved.orders.reduce((s, o) => s + o.platformFee, 0);

      expect(payouts + fees + result.deliveryFee).toBe(result.totalAmount);
    });

    it('never adds the delivery fee to a vendor payout', async () => {
      await service.createCheckout({
        ...baseDto,
        items: [{ productId: 'jollof', quantity: 2 }],
      } as never);

      const order = saved.orders[0];
      // The vendor's figures are computed from goods alone — 6000 / 1200 / 4800.
      expect(order.totalAmount).toBe(6000);
      expect(order.vendorAmount).toBe(4800);
      expect(order.totalAmount + order.platformFee).toBe(7200);
    });

    it('charges one delivery fee however many vendors are involved', async () => {
      const result = await service.createCheckout({
        ...baseDto,
        items: [
          { productId: 'jollof', quantity: 1 },
          { productId: 'yam', quantity: 1 },
        ],
      } as never);

      expect(result.deliveryFee).toBe(DELIVERY_FEE);
    });

    it('charges no delivery fee for pickup', async () => {
      const result = await service.createCheckout({
        ...baseDto,
        fulfillmentType: FulfillmentType.PICKUP,
        deliveryAddress: undefined,
        items: [{ productId: 'jollof', quantity: 1 }],
      } as never);

      expect(result.deliveryFee).toBe(0);
      expect(result.totalAmount).toBe(result.goodsTotal);
    });
  });

  describe('the cart is untrusted', () => {
    it('prices from the database, ignoring whatever the client claimed', async () => {
      products.find.mockResolvedValue([product({ id: 'p1', price: 3500 })]);

      const result = await service.createCheckout({
        ...baseDto,
        items: [{ productId: 'p1', quantity: 1, expectedUnitPrice: 3500 }],
      } as never);

      expect(result.goodsTotal).toBe(3500);
      expect(saved.items[0].unitPrice).toBe(3500);
    });

    it('rejects the whole checkout when a price moved', async () => {
      products.find.mockResolvedValue([product({ id: 'p1', price: 3500 })]);

      await expect(
        service.createCheckout({
          ...baseDto,
          items: [{ productId: 'p1', quantity: 1, expectedUnitPrice: 100 }],
        } as never),
      ).rejects.toThrow(ConflictException);
    });

    it('reports what changed so the buyer can be shown the difference', async () => {
      products.find.mockResolvedValue([product({ id: 'p1', price: 3500 })]);

      await service
        .createCheckout({
          ...baseDto,
          items: [{ productId: 'p1', quantity: 1, expectedUnitPrice: 3000 }],
        } as never)
        .catch((error: ConflictException) => {
          const body = error.getResponse() as {
            code: string;
            changes: Record<string, unknown>[];
          };
          expect(body.code).toBe('CART_CHANGED');
          expect(body.changes[0]).toMatchObject({
            reason: 'PRICE_CHANGED',
            expectedUnitPrice: 3000,
            currentUnitPrice: 3500,
          });
        });
      expect.assertions(2);
    });

    it.each([
      ['a deleted product', [], 'REMOVED'],
      [
        'an unavailable product',
        [product({ isAvailable: false })],
        'UNAVAILABLE',
      ],
      [
        'an unapproved vendor',
        [
          product({
            vendor: { id: 'v1', status: SellerStatus.PENDING, isOpen: true },
          }),
        ],
        'UNAVAILABLE',
      ],
      [
        'a closed vendor',
        [
          product({
            vendor: { id: 'v1', status: SellerStatus.APPROVED, isOpen: false },
          }),
        ],
        'VENDOR_CLOSED',
      ],
    ])('refuses %s', async (_label, found, reason) => {
      products.find.mockResolvedValue(found);

      await service
        .createCheckout({
          ...baseDto,
          items: [{ productId: 'p1', quantity: 1 }],
        } as never)
        .catch((error: ConflictException) => {
          const body = error.getResponse() as { changes: { reason: string }[] };
          expect(body.changes[0].reason).toBe(reason);
        });
      expect.assertions(1);
    });

    it('does not take payment for a rejected cart', async () => {
      products.find.mockResolvedValue([]);

      await service
        .createCheckout({
          ...baseDto,
          items: [{ productId: 'gone', quantity: 1 }],
        } as never)
        .catch(() => undefined);

      expect(payments.initializePayment).not.toHaveBeenCalled();
      expect(saved.checkouts).toHaveLength(0);
    });
  });

  describe('items and rollback', () => {
    it('merges the same product added twice into one line', async () => {
      products.find.mockResolvedValue([product({ id: 'p1', price: 3500 })]);

      await service.createCheckout({
        ...baseDto,
        items: [
          { productId: 'p1', quantity: 1 },
          { productId: 'p1', quantity: 2 },
        ],
      } as never);

      expect(saved.items).toHaveLength(1);
      expect(saved.items[0].quantity).toBe(3);
      expect(saved.items[0].lineTotal).toBe(10500);
    });

    it('snapshots the name and price onto the line', async () => {
      products.find.mockResolvedValue([product()]);

      await service.createCheckout({
        ...baseDto,
        items: [{ productId: 'p1', quantity: 1 }],
      } as never);

      expect(saved.items[0]).toMatchObject({
        productName: 'Jollof Rice with Chicken',
        unitPrice: 3500,
      });
    });

    it('rolls the checkout back when payment initialisation fails', async () => {
      products.find.mockResolvedValue([product()]);
      payments.initializePayment.mockRejectedValue(new Error('Paystack down'));

      await expect(
        service.createCheckout({
          ...baseDto,
          items: [{ productId: 'p1', quantity: 1 }],
        } as never),
      ).rejects.toThrow('Paystack down');

      // An order nobody can pay for must not be left showing in a vendor's queue.
      expect(checkouts.delete).toHaveBeenCalledWith({ id: 'checkout-1' });
    });
  });
});
