import { SellersService } from './sellers.service';
import type { User } from '../auth/entities/auth.entity';

/** A vendor choosing their category in Store details, and seeing what they pay. */
describe("a vendor's category and rate", () => {
  let vendor: Partial<User>;
  let categories: { resolve: jest.Mock; rates: jest.Mock };
  let service: SellersService;

  beforeEach(() => {
    vendor = {
      id: 'v1',
      businessCategory: 'Barbecue',
      categoryId: null,
      customFeePercent: null,
      serviceAreas: [],
    };
    categories = {
      resolve: jest.fn((text: string) =>
        Promise.resolve(
          text.trim().toLowerCase() === 'restaurant'
            ? { categoryId: 'cat-food', businessCategory: 'Restaurant' }
            : { categoryId: null, businessCategory: text.trim() },
        ),
      ),
      rates: jest.fn().mockResolvedValue({
        rateOf: (row: Partial<User>) =>
          row.categoryId === 'cat-food'
            ? { percent: 25, basis: 'CATEGORY', categoryName: 'Restaurant' }
            : { percent: 20, basis: 'STANDARD', categoryName: null },
      }),
    };
    service = new SellersService(
      {
        findOne: jest.fn(() => Promise.resolve(vendor)),
        save: jest.fn((row: Partial<User>) => Promise.resolve(row)),
      } as never,
      {} as never,
      {} as never,
      undefined,
      categories as never,
    );
  });

  it('puts them in the category they picked from the list', async () => {
    const { data } = await service.updateProfile('v1', {
      businessCategory: 'restaurant',
    });

    expect(vendor).toMatchObject({
      categoryId: 'cat-food',
      businessCategory: 'Restaurant',
    });
    expect(data.commission).toMatchObject({ percent: 25, basis: 'CATEGORY' });
  });

  it('keeps "something else" as they wrote it, out of every category', async () => {
    vendor.categoryId = 'cat-food';

    await service.updateProfile('v1', { businessCategory: 'Candles ' });

    expect(vendor).toMatchObject({
      categoryId: null,
      businessCategory: 'Candles',
    });
  });

  it('shows them what Recommend keeps on their profile', async () => {
    const { data } = await service.getProfile('v1');
    expect(data.commission).toMatchObject({ percent: 20, basis: 'STANDARD' });
  });

  it('still loads the profile when the rate cannot be worked out', async () => {
    categories.rates.mockRejectedValue(new Error('db down'));
    const { data } = await service.getProfile('v1');
    expect(data.commission).toBeNull();
  });
});
