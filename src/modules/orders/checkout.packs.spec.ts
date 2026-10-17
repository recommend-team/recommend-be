import { BadRequestException, ConflictException } from '@nestjs/common';
import { CheckoutService } from './checkout.service';
import { createCheckoutSchema } from './dto/create-checkout.dto';
import { Product } from '../products/entities/product.entity';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';

/**
 * Mama Tee's Kitchen from PRODUCT_OPTIONS_PLAN.md: rice and beans with extras, rice and
 * stew with a required protein.
 */
const VENDOR = 'mama-tee';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const IDS = {
  beans: id(1),
  stew: id(2),
  beef: id(3),
  takeaway: id(4),
  water: id(5),
  nylon: id(6),
  chicken: id(7),
  protein: id(10),
  optChicken: id(11),
  optBeef: id(12),
  optFish: id(13),
};

const product = (over: Partial<Product>): Product =>
  ({
    vendorId: VENDOR,
    description: null,
    imageUrl: null,
    isAvailable: true,
    isAddOn: false,
    unit: null,
    vendor: {
      id: VENDOR,
      status: SellerStatus.APPROVED,
      isOpen: true,
      businessName: "Mama Tee's Kitchen",
    },
    ...over,
  }) as Product;

const MENU = [
  product({
    id: IDS.beans,
    name: 'Rice and beans',
    price: 1000,
    unit: 'portion',
  }),
  product({
    id: IDS.stew,
    name: 'Rice and stew',
    price: 1500,
    unit: 'portion',
  }),
  product({ id: IDS.beef, name: 'Beef', price: 1000, isAddOn: true }),
  product({
    id: IDS.takeaway,
    name: 'Takeaway pack',
    price: 200,
    isAddOn: true,
  }),
  product({ id: IDS.water, name: 'Water', price: 300, isAddOn: true }),
  product({ id: IDS.nylon, name: 'Nylon', price: 100, isAddOn: true }),
  product({ id: IDS.chicken, name: 'Chicken', price: 1500, isAddOn: true }),
];

/** Rice and beans takes Beef, Takeaway, Water, Nylon — not Chicken. Stew: Takeaway, Water. */
const TICKED = [
  ...[IDS.beef, IDS.takeaway, IDS.water, IDS.nylon].map((extraId) => ({
    productId: IDS.beans,
    extraId,
  })),
  ...[IDS.takeaway, IDS.water].map((extraId) => ({
    productId: IDS.stew,
    extraId,
  })),
];

const proteinGroup = (fishAvailable = true) => ({
  id: IDS.protein,
  productId: IDS.stew,
  name: 'Choose your protein',
  required: true,
  minPick: 1,
  maxPick: 1,
  position: 0,
  options: [
    {
      id: IDS.optChicken,
      name: 'Chicken',
      priceDelta: '0',
      isAvailable: true,
      position: 0,
    },
    {
      id: IDS.optBeef,
      name: 'Beef',
      priceDelta: '0',
      isAvailable: true,
      position: 1,
    },
    {
      id: IDS.optFish,
      name: 'Fish',
      priceDelta: '300',
      isAvailable: fishAvailable,
      position: 2,
    },
  ],
});

const buyer = {
  buyerName: 'Ada Obi',
  buyerPhone: '+2348011111111',
  fulfillmentType: FulfillmentType.DELIVERY,
  deliveryAddress: '12 Herbert Macaulay Way',
};

describe('Checkout — dishes built as packs', () => {
  let saved: Record<string, unknown>[];
  let groups: ReturnType<typeof proteinGroup>[];
  let service: CheckoutService;

  beforeEach(() => {
    saved = [];
    groups = [proteinGroup()];
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
    service = new CheckoutService(
      { find: jest.fn(() => Promise.resolve(MENU)) } as never,
      { delete: jest.fn() } as never,
      { find: jest.fn(() => Promise.resolve(groups)) } as never,
      {
        initializePayment: jest.fn().mockResolvedValue({
          authorizationUrl: 'https://checkout.paystack.com/x',
          accessCode: 'x',
        }),
      } as never,
      {
        get: jest.fn((key: string) => {
          if (key === 'delivery.feeNgn') return 1500;
          if (key === 'platform.feeRate') return 0.2;
          return undefined;
        }),
      } as never,
      {
        transaction: (work: (m: unknown) => Promise<unknown>) => work(manager),
        query: jest.fn(() => Promise.resolve(TICKED)),
      } as never,
    );
  });

  const place = (items: unknown[]) =>
    service.createCheckout(createCheckoutSchema.parse({ ...buyer, items }));
  const dishRows = () =>
    saved.filter((r) => 'productId' in r && !r.parentItemId);
  const extraRows = () => saved.filter((r) => !!r.parentItemId);

  it('prices a pack: (portions × price + extras) × packs — Ada’s first line', async () => {
    const result = await place([
      {
        productId: IDS.beans,
        quantity: 2,
        packs: 2,
        extras: [
          { productId: IDS.beef, quantity: 2 },
          { productId: IDS.takeaway, quantity: 1 },
        ],
      },
    ]);

    // One pack: 2 × 1,000 + 2 × 1,000 + 200 = 4,200. Two packs: 8,400.
    expect(result.goodsTotal).toBe(8400);
    expect(result.totalAmount).toBe(9900);

    const [dish] = dishRows();
    expect(dish).toMatchObject({
      productName: 'Rice and beans',
      unit: 'portion',
      quantity: 2,
      packs: 2,
      unitPrice: 1000,
      lineTotal: 4000,
    });
    expect(extraRows()).toEqual([
      expect.objectContaining({
        productName: 'Beef',
        quantity: 2,
        packs: 2,
        lineTotal: 4000,
        parentItemId: dish.id,
      }),
      expect.objectContaining({
        productName: 'Takeaway pack',
        quantity: 1,
        packs: 2,
        lineTotal: 400,
        parentItemId: dish.id,
      }),
    ]);
  });

  it('adds a choice’s cost per portion, and records what was chosen', async () => {
    const result = await place([
      {
        productId: IDS.stew,
        quantity: 2,
        choices: [{ groupId: IDS.protein, optionIds: [IDS.optFish] }],
        extras: [{ productId: IDS.water, quantity: 1 }],
      },
    ]);

    // (1,500 + 300) × 2 portions + 300 water = 3,900.
    expect(result.goodsTotal).toBe(3900);
    const [dish] = dishRows();
    expect(dish).toMatchObject({ unitPrice: 1800, lineTotal: 3600 });
    expect(dish.choices).toEqual([
      { groupName: 'Choose your protein', optionName: 'Fish', priceDelta: 300 },
    ]);
  });

  it('quotes a cart the way it will be charged, without placing it', async () => {
    const quote = await service.quote(
      createCheckoutSchema.parse({
        ...buyer,
        items: [
          {
            productId: IDS.beans,
            quantity: 2,
            packs: 2,
            extras: [
              { productId: IDS.beef, quantity: 2 },
              { productId: IDS.takeaway, quantity: 1 },
            ],
          },
          {
            productId: IDS.stew,
            quantity: 1,
            choices: [{ groupId: IDS.protein, optionIds: [IDS.optFish] }],
          },
        ],
      }).items,
    );

    expect(quote).toEqual({
      lines: [
        {
          name: 'Rice and beans (2 portions, with Beef ×2, Takeaway pack ×1)',
          vendorName: "Mama Tee's Kitchen",
          quantity: 2,
          unitPrice: 4200,
          lineTotal: 8400,
        },
        {
          name: 'Rice and stew (1 portion, Protein: Fish)',
          vendorName: "Mama Tee's Kitchen",
          quantity: 1,
          unitPrice: 1800,
          lineTotal: 1800,
        },
      ],
      goodsTotal: 10200,
    });
    expect(saved).toHaveLength(0);
  });

  it('refuses to quote a cart that no longer matches the menu', async () => {
    await expect(
      service.quote([
        {
          productId: IDS.beans,
          quantity: 1,
          extras: [{ productId: IDS.chicken, quantity: 1 }],
        },
      ]),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('keeps the same dish built two ways as two lines', async () => {
    await place([
      {
        productId: IDS.beans,
        quantity: 2,
        extras: [{ productId: IDS.beef, quantity: 2 }],
      },
      { productId: IDS.beans, quantity: 1, packs: 1 },
    ]);
    expect(dishRows()).toHaveLength(2);
  });

  it('refuses an extra not ticked on that dish, naming both', async () => {
    const error = await place([
      {
        productId: IDS.beans,
        quantity: 1,
        extras: [{ productId: IDS.chicken, quantity: 1 }],
      },
    ]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'CART_CHANGED',
      changes: [
        expect.objectContaining({
          reason: 'EXTRA_NOT_OFFERED',
          productName: 'Chicken',
          dishName: 'Rice and beans',
        }),
      ],
    });
  });

  it('refuses a dish whose required choice wasn’t answered — an older app, or added since', async () => {
    const error = await place([{ productId: IDS.stew, quantity: 1 }]).catch(
      (e: unknown) => e,
    );
    expect((error as ConflictException).getResponse()).toMatchObject({
      changes: [
        expect.objectContaining({
          reason: 'CHOICES_NEEDED',
          groupName: 'Choose your protein',
        }),
      ],
    });
  });

  it('refuses an option that has run out', async () => {
    groups = [proteinGroup(false)];
    const error = await place([
      {
        productId: IDS.stew,
        quantity: 1,
        choices: [{ groupId: IDS.protein, optionIds: [IDS.optFish] }],
      },
    ]).catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      changes: [
        expect.objectContaining({
          reason: 'CHOICE_UNAVAILABLE',
          optionName: 'Fish',
        }),
      ],
    });
  });

  it('refuses picking more than the choice allows', async () => {
    const error = await place([
      {
        productId: IDS.stew,
        quantity: 1,
        choices: [
          { groupId: IDS.protein, optionIds: [IDS.optBeef, IDS.optChicken] },
        ],
      },
    ]).catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      changes: [expect.objectContaining({ reason: 'CHOICES_NEEDED' })],
    });
  });

  it('refuses an extra sold as a pack of its own', async () => {
    await expect(
      place([{ productId: IDS.beef, quantity: 1, packs: 1 }]),
    ).rejects.toThrow(BadRequestException);
  });

  it('still takes an older app’s flat cart, attaching its extras to the first dish', async () => {
    const result = await place([
      { productId: IDS.beans, quantity: 3 },
      { productId: IDS.water, quantity: 2 },
    ]);

    expect(result.goodsTotal).toBe(3600);
    const [dish] = dishRows();
    expect(dish).toMatchObject({ quantity: 3, packs: 1, lineTotal: 3000 });
    expect(extraRows()).toEqual([
      expect.objectContaining({
        productName: 'Water',
        quantity: 2,
        packs: 1,
        parentItemId: dish.id,
      }),
    ]);
  });
});

describe('Checkout line limits', () => {
  const line = (over: Record<string, unknown>) =>
    createCheckoutSchema.safeParse({
      ...buyer,
      items: [{ productId: IDS.beans, ...over }],
    });

  it('allows up to 10 portions in a pack, 5 of each extra, 50 packs', () => {
    expect(
      line({
        quantity: 10,
        packs: 50,
        extras: [{ productId: IDS.beef, quantity: 5 }],
      }).success,
    ).toBe(true);
    expect(line({ quantity: 11, packs: 1 }).success).toBe(false);
    expect(
      line({ quantity: 1, extras: [{ productId: IDS.beef, quantity: 6 }] })
        .success,
    ).toBe(false);
    expect(line({ quantity: 1, packs: 51 }).success).toBe(false);
  });

  it('leaves an older app’s plain line at its old ceiling of 50', () => {
    expect(line({ quantity: 50 }).success).toBe(true);
  });
});
