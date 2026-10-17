import { BadRequestException } from '@nestjs/common';
import { CheckoutService } from './checkout.service';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';
import { CheckoutSource } from '../../common/enums/checkout-source.enum';

const AJAH = '0536c260-0497-4ed7-90ca-179ee12ce90e';

const product = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'Jollof Rice with Chicken',
  price: 3500,
  isAvailable: true,
  isAddOn: false,
  vendorId: 'v1',
  vendor: {
    id: 'v1',
    businessName: 'Mama Ngozi Kitchen',
    status: SellerStatus.APPROVED,
    isOpen: true,
  },
  ...over,
});

const storefrontDto = {
  items: [{ productId: 'p1', quantity: 2 }],
  buyerName: 'Ada Obi',
  buyerPhone: '+2348012345678',
  buyerEmail: 'ada@example.com',
  fulfillmentType: FulfillmentType.DELIVERY,
  deliveryAddress: '12 Herbert Macaulay Way, Yaba',
  areaId: AJAH,
};

describe('a checkout from the storefront', () => {
  let service: CheckoutService;
  let payments: { initializePayment: jest.Mock };
  let saved: Record<string, unknown>[];
  /** Vendors the area query says deliver to the buyer's area. */
  let serving: string[];
  let websiteUrl: string;

  beforeEach(() => {
    saved = [];
    serving = ['v1'];
    websiteUrl = 'https://recommend.ng';
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
      save: (row: Record<string, unknown>) => {
        row.id = row.id ?? `row-${saved.length + 1}`;
        saved.push(row);
        return Promise.resolve(row);
      },
    };

    service = new CheckoutService(
      { find: jest.fn().mockResolvedValue([product()]) } as never,
      { delete: jest.fn() } as never,
      payments as never,
      {
        get: jest.fn((key: string) => {
          if (key === 'delivery.feeNgn') return 1500;
          if (key === 'delivery.pickupEnabled') return false;
          if (key === 'platform.feeRate') return 0.2;
          if (key === 'app.websiteUrl') return websiteUrl;
          return undefined;
        }),
      } as never,
      {
        transaction: (work: (m: unknown) => Promise<unknown>) => work(manager),
        query: jest.fn(() =>
          Promise.resolve(serving.map((vendorId) => ({ vendorId }))),
        ),
      } as never,
    );
  });

  const checkout = () => saved.find((row) => 'reference' in row);

  it('is recorded as a storefront order', async () => {
    await service.createCheckout(
      storefrontDto,
      null,
      CheckoutSource.STOREFRONT,
    );

    expect(checkout()?.source).toBe(CheckoutSource.STOREFRONT);
  });

  it('needs an email — the receipt and delivery code go there', async () => {
    await expect(
      service.createCheckout(
        { ...storefrontDto, buyerEmail: undefined },
        null,
        CheckoutSource.STOREFRONT,
      ),
    ).rejects.toMatchObject({ response: { code: 'EMAIL_REQUIRED' } });
    expect(saved).toHaveLength(0);
  });

  it('needs the area for a delivery', async () => {
    await expect(
      service.createCheckout(
        { ...storefrontDto, areaId: undefined },
        null,
        CheckoutSource.STOREFRONT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an area the vendor does not deliver to, by name, before payment', async () => {
    serving = [];

    const refusal = await service
      .createCheckout(storefrontDto, null, CheckoutSource.STOREFRONT)
      .catch((error: BadRequestException) => error.getResponse());

    expect(refusal).toMatchObject({ code: 'AREA_NOT_SERVED' });
    expect((refusal as { message: string }).message).toContain(
      'Mama Ngozi Kitchen',
    );
    expect(payments.initializePayment).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it('sends the buyer back to their order on the website after paying', async () => {
    const result = await service.createCheckout(
      storefrontDto,
      null,
      CheckoutSource.STOREFRONT,
    );

    expect(payments.initializePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'ada@example.com',
        callbackUrl: `https://recommend.ng/order/${result.reference}`,
      }),
    );
  });

  it('leaves the return address to Paystack when the website address is not set', async () => {
    websiteUrl = '';

    await service.createCheckout(
      storefrontDto,
      null,
      CheckoutSource.STOREFRONT,
    );

    expect(payments.initializePayment).toHaveBeenCalledWith(
      expect.objectContaining({ callbackUrl: undefined }),
    );
  });

  describe('a chat checkout is unchanged', () => {
    it('needs no email and no area, and pays in the popup with no return address', async () => {
      await service.createCheckout({
        ...storefrontDto,
        buyerEmail: undefined,
        areaId: undefined,
      });

      expect(checkout()?.source).toBe(CheckoutSource.CHAT);
      expect(payments.initializePayment).toHaveBeenCalledWith(
        expect.objectContaining({ callbackUrl: undefined }),
      );
    });

    it('is recorded as an admin order when an admin placed it', async () => {
      await service.createCheckout(storefrontDto, 'admin-1');

      expect(checkout()?.source).toBe(CheckoutSource.ADMIN);
    });
  });
});
