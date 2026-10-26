import { BadRequestException } from '@nestjs/common';
import { CheckoutService } from './checkout.service';
import { createCheckoutSchema } from './dto/create-checkout.dto';
import { CheckoutSource } from '../../common/enums/checkout-source.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';
import type { PlacesService } from '../places/places.service';

const VENDOR = 'v1';
const AJAH = '00000000-0000-4000-8000-0000000000a1';
const RICE = '00000000-0000-4000-8000-000000000001';

const rice = {
  id: RICE,
  vendorId: VENDOR,
  name: 'Jollof Rice',
  price: 3000,
  isAvailable: true,
  isAddOn: false,
  unit: null,
  vendor: {
    id: VENDOR,
    status: SellerStatus.APPROVED,
    isOpen: true,
    businessName: 'Mama Tee',
  },
};

const PICKED = {
  placeId: 'ChIJabc',
  address: 'Abraham Adesanya, Ajah, Lekki 106104, Lagos, Nigeria',
  latitude: 6.469065,
  longitude: 3.585036,
  areaId: AJAH,
  areaName: 'Ajah',
};

/** An address picked from Google, at checkout. */
describe('Checkout — a delivery address picked from Google', () => {
  let saved: Record<string, unknown>[];
  let verify: jest.Mock;
  let served: string[];

  const build = (places?: Pick<PlacesService, 'verify'>) => {
    const manager = {
      create: (_entity: unknown, data: Record<string, unknown>) => ({
        ...data,
      }),
      save: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        for (const row of Array.isArray(rows) ? rows : [rows]) {
          row.id = row.id ?? `row-${saved.length + 1}`;
          saved.push(row);
        }
        return Promise.resolve(rows);
      },
    };
    return new CheckoutService(
      { find: jest.fn(() => Promise.resolve([rice])) } as never,
      { delete: jest.fn() } as never,
      { find: jest.fn(() => Promise.resolve([])) } as never,
      {
        initializePayment: jest.fn().mockResolvedValue({
          authorizationUrl: 'https://checkout.paystack.com/x',
          accessCode: 'x',
        }),
      } as never,
      {
        get: jest.fn((key: string) =>
          key === 'delivery.feeNgn'
            ? 1500
            : key === 'platform.feeRate'
              ? 0.2
              : undefined,
        ),
      } as never,
      {
        transaction: (work: (m: unknown) => Promise<unknown>) => work(manager),
        query: jest.fn((sql: string, params: unknown[]) =>
          // Which vendors deliver to the area asked about.
          Promise.resolve(
            sql.includes('vendor_service_areas')
              ? served.includes(params[0] as string)
                ? [{ vendorId: VENDOR }]
                : []
              : [],
          ),
        ),
      } as never,
      places as PlacesService | undefined,
    );
  };

  const order = (over: Record<string, unknown>) =>
    createCheckoutSchema.parse({
      items: [{ productId: RICE, quantity: 1 }],
      buyerName: 'Ada Obi',
      buyerPhone: '+2348031234567',
      buyerEmail: 'ada@example.com',
      fulfillmentType: 'DELIVERY',
      ...over,
    });

  beforeEach(() => {
    saved = [];
    served = [AJAH];
    verify = jest.fn().mockReturnValue(PICKED);
  });

  it('delivers to the picked place: its address with the house number, its area, its pin', async () => {
    const service = build({ verify });

    await service.createCheckout(
      order({
        deliveryPlace: {
          token: 'signed.token',
          details: 'House 12, blue gate',
        },
      }),
      null,
      CheckoutSource.STOREFRONT,
    );

    expect(verify).toHaveBeenCalledWith('signed.token');
    const [checkout] = saved;
    expect(checkout).toMatchObject({
      deliveryAddress:
        'House 12, blue gate, Abraham Adesanya, Ajah, Lekki 106104, Lagos, Nigeria',
      deliveryPlaceId: 'ChIJabc',
      deliveryLat: 6.469065,
      deliveryLng: 3.585036,
    });
    // The vendor's order carries the pin too, for the rider.
    expect(saved.find((row) => 'vendorAmount' in row)).toMatchObject({
      deliveryPlaceId: 'ChIJabc',
      deliveryLat: 6.469065,
    });
  });

  it('needs no area chosen on the storefront — the picked place says where', async () => {
    const service = build({ verify });

    await expect(
      service.createCheckout(
        order({ deliveryPlace: { token: 'signed.token' } }),
        null,
        CheckoutSource.STOREFRONT,
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a picked place the vendor does not deliver to, before payment', async () => {
    served = [];
    const service = build({ verify });

    await expect(
      service.createCheckout(
        order({ deliveryPlace: { token: 'signed.token' } }),
        null,
        CheckoutSource.STOREFRONT,
      ),
    ).rejects.toBeDefined();
    expect(saved).toEqual([]);
  });

  it('refuses a token that does not check out', async () => {
    verify.mockImplementation(() => {
      throw new BadRequestException({ code: 'PLACE_INVALID' });
    });
    const service = build({ verify });

    await expect(
      service.createCheckout(
        order({ deliveryPlace: { token: 'forged.token' } }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(saved).toEqual([]);
  });

  it('still takes an address typed by hand, with no pin', async () => {
    const service = build({ verify });

    await service.createCheckout(
      order({ deliveryAddress: '4 New Estate Road, Ajah', areaId: AJAH }),
      null,
      CheckoutSource.STOREFRONT,
    );

    expect(verify).not.toHaveBeenCalled();
    expect(saved[0]).toMatchObject({
      deliveryAddress: '4 New Estate Road, Ajah',
      deliveryPlaceId: null,
      deliveryLat: null,
    });
  });

  it('wants an address of one kind or the other for a delivery', () => {
    expect(() => order({})).toThrow(/deliveryAddress is required/);
  });
});
