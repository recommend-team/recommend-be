import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  CategoriesService,
  cleanWords,
  suggestCategory,
} from './categories.service';
import { Category } from './entities/category.entity';
import { CategoryRateChange } from './entities/category-rate-change.entity';
import { User } from '../auth/entities/auth.entity';
import { Role } from '../../common/enums/roles.enum';
import {
  CATEGORIES_CHANGED_EVENT,
  COMMISSION_RATE_RAISED_EVENT,
  CommissionRateRaisedEvent,
} from '../../common/events/categories.events';
import { DEFAULT_CATEGORY_WORDS } from '../../common/constants/default-categories';

/** A query builder whose every step returns itself, ending in the given results. */
function chain(end: Record<string, unknown> = {}) {
  const qb: Record<string, jest.Mock> = {};
  for (const step of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
    'update',
    'set',
    'insert',
    'into',
    'values',
    'orIgnore',
    'returning',
  ]) {
    qb[step] = jest.fn(() => qb);
  }
  qb.getOne = jest.fn().mockResolvedValue(end.getOne ?? null);
  qb.getRawMany = jest.fn().mockResolvedValue(end.getRawMany ?? []);
  qb.execute = jest.fn().mockResolvedValue(end.execute ?? { raw: [] });
  return qb;
}

const SUPER = { id: 'super-1', role: Role.SUPER_ADMIN };
const ADMIN = { id: 'admin-1', role: Role.ADMIN };

const category = (over: Partial<Category> = {}): Category =>
  ({
    id: 'cat-beauty',
    name: 'Beauty',
    feePercent: 20,
    keywords: ['hair', 'wig'],
    isActive: true,
    createdByAdminId: null,
    createdAt: new Date('2026-11-01'),
    updatedAt: new Date('2026-11-01'),
    deletedAt: null,
    ...over,
  }) as Category;

type VendorRow = Pick<
  User,
  'id' | 'categoryId' | 'businessCategory' | 'customFeePercent'
> & { role: Role; businessName?: string; status?: string };

const vendor = (over: Partial<VendorRow> = {}): VendorRow => ({
  id: 'v1',
  role: Role.SELLER,
  categoryId: 'cat-beauty',
  businessCategory: 'Beauty',
  customFeePercent: null,
  ...over,
});

/** The rate-rise events the service emitted, in order. */
function raised(events: { emit: jest.Mock }): CommissionRateRaisedEvent[] {
  return events.emit.mock.calls
    .filter(([name]) => name === COMMISSION_RATE_RAISED_EVENT)
    .map(([, event]) => event as CommissionRateRaisedEvent);
}

describe('CategoriesService', () => {
  let rows: Category[];
  let vendors: VendorRow[];
  let categories: {
    count: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let users: {
    createQueryBuilder: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
  };
  let rateChanges: { find: jest.Mock };
  let manager: {
    create: jest.Mock;
    save: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let renameQuery: ReturnType<typeof chain>;
  let usersQuery: ReturnType<typeof chain>;
  let dataSource: { transaction: jest.Mock; query: jest.Mock };
  let events: { emit: jest.Mock };
  let configured: number | undefined;
  let service: CategoriesService;

  /** Enough of `find`'s `where` for these tests: ids, category, no rate of their own. */
  const findVendors = (where: Record<string, unknown>): VendorRow[] => {
    const ids = (where.id as { _value?: string[] } | undefined)?._value;
    return vendors.filter(
      (row) =>
        (!ids || ids.includes(row.id)) &&
        (typeof where.categoryId !== 'string' ||
          row.categoryId === where.categoryId) &&
        (typeof where.categoryId !== 'object' || row.categoryId === null) &&
        (where.customFeePercent === undefined || row.customFeePercent === null),
    );
  };

  beforeEach(() => {
    rows = [
      category(),
      category({
        id: 'cat-phone',
        name: 'Phone Accessories',
        feePercent: 10,
        keywords: ['charger', 'power bank'],
      }),
      category({
        id: 'cat-food',
        name: 'Restaurant',
        feePercent: 25,
        keywords: ['food', 'jollof'],
      }),
    ];
    vendors = [];
    configured = 20;
    categories = {
      count: jest.fn().mockResolvedValue(rows.length),
      find: jest.fn(() => Promise.resolve(rows)),
      findOne: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.find((row) => row.id === where.id) ?? null),
      ),
      // Name lookups: the row whose lowercased name matches.
      createQueryBuilder: jest.fn(() => {
        let wanted = '';
        const qb = chain();
        qb.where.mockImplementation(
          (_sql: string, params: { name: string }) => {
            wanted = params.name;
            return qb;
          },
        );
        qb.getOne.mockImplementation(() =>
          Promise.resolve(
            rows.find((row) => row.name.toLowerCase() === wanted) ?? null,
          ),
        );
        return qb;
      }),
    };
    usersQuery = chain({
      // Vendor counts per category.
      getRawMany: [{ categoryId: 'cat-beauty', count: '4' }],
    });
    users = {
      createQueryBuilder: jest.fn(() => usersQuery),
      find: jest.fn(
        (options: { where: Record<string, unknown>; select?: string[] }) =>
          Promise.resolve(
            options.select?.includes('firstName')
              ? [{ id: 'super-1', firstName: 'Ada', lastName: 'Obi' }]
              : findVendors(options.where),
          ),
      ),
      findOne: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(vendors.find((row) => row.id === where.id) ?? null),
      ),
      count: jest.fn().mockResolvedValue(2),
    };
    rateChanges = { find: jest.fn().mockResolvedValue([]) };
    renameQuery = chain();
    manager = {
      create: jest.fn((_entity: unknown, data: object) => ({ ...data })),
      save: jest.fn((row: Category) =>
        Promise.resolve({ ...row, id: row.id ?? 'cat-new' }),
      ),
      insert: jest.fn().mockResolvedValue({}),
      update: jest.fn(
        (_entity: unknown, where: { id: string }, set: Partial<VendorRow>) => {
          const row = vendors.find((candidate) => candidate.id === where.id);
          if (row) Object.assign(row, set);
          return Promise.resolve({});
        },
      ),
      createQueryBuilder: jest.fn(() => renameQuery),
    };
    dataSource = {
      transaction: jest.fn((work: (m: typeof manager) => Promise<unknown>) =>
        work(manager),
      ),
      query: jest.fn().mockResolvedValue([[], 0]),
    };
    events = { emit: jest.fn() };

    service = new CategoriesService(
      categories as never,
      rateChanges as never,
      users as never,
      dataSource as never,
      { get: jest.fn(() => configured) } as never,
      events as never,
    );
  });

  describe('creating a category', () => {
    it('starts it at the standard rate when an admin creates it, and logs that', async () => {
      const created = await service.create(
        { name: 'Pets', keywords: ['Dog food', 'cat litter', 'dog food'] },
        ADMIN,
      );

      expect(created.feePercent).toBe(20);
      expect(manager.create).toHaveBeenCalledWith(
        Category,
        expect.objectContaining({
          name: 'Pets',
          keywords: ['dog food', 'cat litter'],
          createdByAdminId: 'admin-1',
        }),
      );
      expect(manager.insert).toHaveBeenCalledWith(CategoryRateChange, {
        categoryId: 'cat-new',
        previousPercent: null,
        newPercent: 20,
        changedByAdminId: 'admin-1',
      });
      expect(events.emit).toHaveBeenCalledWith(CATEGORIES_CHANGED_EVENT);
    });

    it("won't let an admin set the percentage", async () => {
      await expect(
        service.create({ name: 'Pets', feePercent: 8 }, ADMIN),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('lets the Super Admin create it at its own rate', async () => {
      const created = await service.create(
        { name: 'Pets', feePercent: 8 },
        SUPER,
      );
      expect(created.feePercent).toBe(8);
    });

    it('refuses a name already taken, whatever its capitals', async () => {
      await expect(service.create({ name: 'BEAUTY' }, ADMIN)).rejects.toThrow(
        'There is already a category called Beauty.',
      );
    });

    it('refuses a word another category already owns, and says which', async () => {
      await expect(
        service.create(
          { name: 'Gadgets', keywords: ['laptop', 'Charger'] },
          ADMIN,
        ),
      ).rejects.toThrow(/"charger" \(Phone Accessories\)/);
    });
  });

  describe("changing a category's percentage", () => {
    it('is for the Super Admin only', async () => {
      await expect(
        service.changeRate('cat-beauty', { feePercent: 10 }, ADMIN),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('records from what, to what, and who', async () => {
      const changed = await service.changeRate(
        'cat-beauty',
        { feePercent: 10 },
        SUPER,
      );

      expect(changed.feePercent).toBe(10);
      expect(manager.insert).toHaveBeenCalledWith(CategoryRateChange, {
        categoryId: 'cat-beauty',
        previousPercent: 20,
        newPercent: 10,
        changedByAdminId: 'super-1',
      });
      expect(events.emit).toHaveBeenCalledWith(CATEGORIES_CHANGED_EVENT);
    });

    it('tells each vendor paying it when it goes up — not those with their own rate', async () => {
      vendors = [
        vendor({ id: 'v1' }),
        vendor({ id: 'v2' }),
        vendor({ id: 'v3', customFeePercent: 5 }),
        vendor({ id: 'v4', categoryId: 'cat-food' }),
      ];

      await service.changeRate('cat-beauty', { feePercent: 30 }, SUPER);

      expect(raised(events)).toEqual([
        new CommissionRateRaisedEvent('v1', 20, 30),
        new CommissionRateRaisedEvent('v2', 20, 30),
      ]);
    });

    it('tells nobody when it goes down', async () => {
      vendors = [vendor()];
      await service.changeRate('cat-beauty', { feePercent: 10 }, SUPER);
      expect(raised(events)).toEqual([]);
    });

    it('logs nothing when the rate is the same', async () => {
      await service.changeRate('cat-beauty', { feePercent: 20 }, SUPER);
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('says when the category does not exist', async () => {
      await expect(
        service.changeRate('missing', { feePercent: 10 }, SUPER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('shows the history with who set each rate', async () => {
      rateChanges.find.mockResolvedValue([
        {
          id: 'r2',
          createdAt: new Date('2026-11-20'),
          previousPercent: 20,
          newPercent: 10,
          changedByAdminId: 'super-1',
        },
        {
          id: 'r1',
          createdAt: new Date('2026-11-01'),
          previousPercent: null,
          newPercent: 20,
          changedByAdminId: null,
        },
      ]);

      const history = await service.rateHistory('cat-beauty');

      expect(history.map((change) => change.changedByName)).toEqual([
        'Ada O.',
        null,
      ]);
    });
  });

  describe("a vendor's own rate", () => {
    beforeEach(() => {
      vendors = [vendor({ id: 'v1', categoryId: 'cat-food' })];
    });

    it('is for the Super Admin only', async () => {
      await expect(
        service.setVendorRate('v1', 5, ADMIN),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('replaces their category rate, is logged against them, and tells nobody when lower', async () => {
      const rate = await service.setVendorRate('v1', 5, SUPER);

      expect(rate).toMatchObject({
        percent: 5,
        basis: 'CUSTOM',
        categoryName: 'Restaurant',
        categoryPercent: 25,
      });
      expect(manager.insert).toHaveBeenCalledWith(CategoryRateChange, {
        categoryId: null,
        vendorId: 'v1',
        previousPercent: null,
        newPercent: 5,
        changedByAdminId: 'super-1',
      });
      expect(raised(events)).toEqual([]);
    });

    it('tells them when removing it means paying their category rate again', async () => {
      vendors[0].customFeePercent = 5;

      const rate = await service.setVendorRate('v1', null, SUPER);

      expect(rate).toMatchObject({ percent: 25, basis: 'CATEGORY' });
      expect(raised(events)).toEqual([
        new CommissionRateRaisedEvent('v1', 5, 25),
      ]);
    });

    it('is not for someone who is not a vendor', async () => {
      await expect(
        service.setVendorRate('nobody', 5, SUPER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('putting vendors in a category', () => {
    it('moves them, and tells those who now pay more', async () => {
      vendors = [
        vendor({ id: 'cheap', categoryId: null, businessCategory: 'Barbecue' }),
        vendor({
          id: 'own-rate',
          categoryId: null,
          businessCategory: 'Grills',
          customFeePercent: 5,
        }),
      ];
      // The update moves them, as the database would.
      usersQuery.execute.mockImplementation(() => {
        for (const row of vendors) row.categoryId = 'cat-food';
        return Promise.resolve({});
      });

      const result = await service.assignVendors('cat-food', [
        'cheap',
        'own-rate',
      ]);

      expect(result).toEqual({ moved: 2 });
      expect(usersQuery.set).toHaveBeenCalledWith({
        categoryId: 'cat-food',
        businessCategory: 'Restaurant',
      });
      // 20% standard → 25% Restaurant; the vendor with their own rate is unaffected.
      expect(raised(events)).toEqual([
        new CommissionRateRaisedEvent('cheap', 20, 25),
      ]);
    });

    it('suggests the category their own words point at', () => {
      expect(suggestCategory('Barbecue, food & drinks', rows)?.name).toBe(
        'Restaurant',
      );
      expect(suggestCategory('Wigs and lashes', rows)?.name).toBe('Beauty');
      expect(suggestCategory('Candles', rows)).toBeNull();
      // Pointing at two equally is no suggestion.
      expect(suggestCategory('food and wigs', rows)).toBeNull();
    });

    it('lists those in no category, each with a suggestion', async () => {
      vendors = [
        vendor({
          id: 'v9',
          categoryId: null,
          businessCategory: 'Hair & wigs',
          businessName: 'Ada Hair',
        }),
      ];

      const list = await service.uncategorised();

      expect(list).toEqual([
        expect.objectContaining({
          id: 'v9',
          businessName: 'Ada Hair',
          suggestedCategoryId: 'cat-beauty',
          suggestedCategoryName: 'Beauty',
        }),
      ]);
    });
  });

  describe('choosing a category by name', () => {
    it('links a name from the list, written as the category writes it', async () => {
      await expect(service.resolve('  beauty ')).resolves.toEqual({
        categoryId: 'cat-beauty',
        businessCategory: 'Beauty',
      });
    });

    it('keeps anything else as typed, in no category', async () => {
      await expect(service.resolve('Candles')).resolves.toEqual({
        categoryId: null,
        businessCategory: 'Candles',
      });
      await expect(service.resolve('  ')).resolves.toEqual({
        categoryId: null,
        businessCategory: null,
      });
    });
  });

  describe('editing a category', () => {
    it('renames its vendors’ stores with it', async () => {
      await service.update('cat-beauty', { name: 'Beauty & Hair' });

      expect(renameQuery.set).toHaveBeenCalledWith({
        businessCategory: 'Beauty & Hair',
      });
      expect(renameQuery.where).toHaveBeenCalledWith('"categoryId" = :id', {
        id: 'cat-beauty',
      });
    });

    it('archives without touching vendors', async () => {
      const archived = await service.update('cat-beauty', { isActive: false });

      expect(archived.isActive).toBe(false);
      expect(renameQuery.execute).not.toHaveBeenCalled();
    });

    it('may keep its own words', async () => {
      await expect(
        service.update('cat-beauty', { keywords: ['hair', 'wig', 'braids'] }),
      ).resolves.toMatchObject({ keywords: ['hair', 'wig', 'braids'] });
    });
  });

  describe('the list', () => {
    it("counts each category's vendors, and those in none", async () => {
      const list = await service.list();

      expect(
        list.categories.find((row) => row.name === 'Beauty')?.vendorCount,
      ).toBe(4);
      expect(list.uncategorisedVendors).toBe(2);
      expect(list.standardPercent).toBe(20);
    });

    it('offers vendors only the active categories, with their rates', async () => {
      categories.find.mockResolvedValueOnce([rows[0]]);
      await expect(service.options()).resolves.toEqual([
        { id: 'cat-beauty', name: 'Beauty', feePercent: 20 },
      ]);
      expect(categories.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } }),
      );
    });
  });

  describe('rates for checkout', () => {
    it('charges their own rate, else their category rate, else the standard one', async () => {
      const rates = await service.rates();

      expect(
        rates.rateOf({ categoryId: 'cat-food', customFeePercent: 12 }),
      ).toMatchObject({ percent: 12, basis: 'CUSTOM', categoryPercent: 25 });
      expect(rates.percentFor({ categoryId: 'cat-food' })).toBe(25);
      expect(rates.rateOf({ businessCategory: 'Candles' })).toMatchObject({
        percent: 20,
        basis: 'STANDARD',
        categoryName: null,
      });
    });

    it('still counts a vendor not yet linked who wrote the category name', async () => {
      const rates = await service.rates();
      expect(rates.percentFor({ businessCategory: '  restaurant ' })).toBe(25);
    });

    it('uses the configured standard rate, or 20% without one', async () => {
      configured = 15;
      expect((await service.rates()).percentFor({})).toBe(15);
      configured = undefined;
      expect((await service.rates()).percentFor({})).toBe(20);
    });
  });

  describe('starting up', () => {
    it('adds the starting categories at the standard rate, once', async () => {
      categories.count.mockResolvedValue(0);
      const inserts: ReturnType<typeof chain>[] = [];
      manager.createQueryBuilder.mockImplementation(() => {
        const qb = chain({
          execute: { raw: [{ id: `cat-${inserts.length}` }] },
        });
        inserts.push(qb);
        return qb;
      });

      await service.onApplicationBootstrap();

      const names = Object.keys(DEFAULT_CATEGORY_WORDS);
      expect(inserts).toHaveLength(names.length);
      expect(inserts[0].values).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Restaurant', feePercent: 20 }),
      );
      expect(manager.insert).toHaveBeenCalledTimes(names.length);
      expect(events.emit).toHaveBeenCalledWith(CATEGORIES_CHANGED_EVENT);
    });

    it('leaves the list alone once there is one, but still links vendors by name', async () => {
      await service.onApplicationBootstrap();

      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining(
          'LOWER(TRIM(u."businessCategory")) = LOWER(c.name)',
        ),
        [Role.SELLER],
      );
    });
  });

  it('stores words lowercase, without repeats or blanks', () => {
    expect(
      cleanWords(['Hair Extensions', ' hair extensions ', '', 'Wig!']),
    ).toEqual(['hair extensions', 'wig']);
  });
});
