import { LocalCatalogAdapter } from './local-catalog.adapter';

// Monday 19 October 2026, 8pm in Lagos.
const MONDAY_EVENING = new Date('2026-10-19T20:00:00+01:00');

const day = (isOpen: boolean, open = '09:00', close = '19:00') => ({
  isOpen,
  open,
  close,
});
/** Open 9am–7pm on weekdays — so closed on Monday evening, opening Tuesday 9am. */
const weekdays = {
  monday: day(true),
  tuesday: day(true),
  wednesday: day(true),
  thursday: day(true),
  friday: day(true),
  saturday: day(false),
  sunday: day(false),
};

const vendor = (id: string, operatingHours: unknown, isOpen = true) => ({
  id,
  businessName: id,
  slug: id,
  businessCategory: 'Food',
  serviceAreas: [],
  businessLogoUrl: null,
  isOpen,
  operatingHours,
});

/** A query builder that answers every chained call with itself and `rows` at the end. */
const builderReturning = (rows: unknown[]) => {
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'leftJoinAndSelect',
    'innerJoinAndSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'take',
  ]) {
    qb[method] = jest.fn(() => qb);
  }
  qb.getMany = jest.fn().mockResolvedValue(rows);
  return qb;
};

describe('LocalCatalogAdapter — open vendors first', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: MONDAY_EVENING, doNotFake: ['nextTick'] });
  });
  afterEach(() => jest.useRealTimers());

  it('puts a vendor closed by their hours after open ones, saying when they open', async () => {
    // The query sorts on the switch only, so both arrive "open", newest first.
    const qb = builderReturning([
      vendor('after-hours', weekdays),
      vendor('no-hours', null),
    ]);
    const adapter = new LocalCatalogAdapter(
      { createQueryBuilder: () => qb } as never,
      {} as never,
    );

    const found = await adapter.searchVendors({ limit: 5 });

    expect(found.map((v) => [v.id, v.isOpen, v.opensAt])).toEqual([
      ['no-hours', true, null],
      ['after-hours', false, '2026-10-20T08:00:00.000Z'],
    ]);
    // Reads more than it returns, so open vendors past the limit still surface.
    expect(qb.take).toHaveBeenCalledWith(15);
  });

  it('cuts to the limit after sorting', async () => {
    const qb = builderReturning([
      vendor('after-hours', weekdays),
      vendor('open-1', null),
      vendor('open-2', null),
    ]);
    const adapter = new LocalCatalogAdapter(
      { createQueryBuilder: () => qb } as never,
      {} as never,
    );

    const found = await adapter.searchVendors({ limit: 2 });

    expect(found.map((v) => v.id)).toEqual(['open-1', 'open-2']);
  });

  it('puts items from a vendor closed by their hours after the rest', async () => {
    const product = (id: string, seller: ReturnType<typeof vendor>) => ({
      id,
      name: id,
      description: null,
      price: '1000',
      imageUrl: null,
      vendorId: seller.id,
      vendor: seller,
      isAddOn: false,
    });
    const qb = builderReturning([
      product('late-jollof', vendor('after-hours', weekdays)),
      product('fried-rice', vendor('no-hours', null)),
    ]);
    const adapter = new LocalCatalogAdapter(
      {} as never,
      { createQueryBuilder: () => qb } as never,
    );

    const found = await adapter.searchProducts({ text: 'rice' });

    expect(found.map((p) => [p.id, p.vendorIsOpen, p.vendorOpensAt])).toEqual([
      ['fried-rice', true, null],
      ['late-jollof', false, '2026-10-20T08:00:00.000Z'],
    ]);
  });
});
