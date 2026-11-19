import { emptyHarvest, executeTool, withoutVendorWords } from './tools';

const LEKKI = 'a0000000-0000-4000-8000-000000000001';

const wig = {
  id: 'p-wig',
  name: 'Deep Wave Human Hair Wig',
  description: null,
  price: 50000,
  imageUrl: null,
  vendorId: 'v-jollof',
  vendorName: 'Jollof Pot',
  vendorSlug: 'jollof-pot',
  vendorIsOpen: true,
  vendorOpensAt: null,
  isAddOn: false,
};

const grill = {
  id: 'v-grill',
  name: 'Lekki Hair Grill',
  slug: 'lekki-hair-grill',
  category: 'Restaurant',
  areas: [{ id: LEKKI, name: 'Lekki' }],
  isOpen: true,
  opensAt: null,
  logoUrl: null,
};

describe('search_vendors — finding vendors by what they sell', () => {
  let catalog: {
    searchVendors: jest.Mock;
    searchProducts: jest.Mock;
    listCategories: jest.Mock;
    getDishOptions: jest.Mock;
  };
  const context = () => ({
    catalog: catalog as never,
    locations: { searchAreas: jest.fn().mockResolvedValue([]) } as never,
    areaId: LEKKI,
  });

  beforeEach(() => {
    catalog = {
      searchVendors: jest.fn().mockResolvedValue([]),
      searchProducts: jest.fn().mockResolvedValue([]),
      listCategories: jest.fn().mockResolvedValue([]),
      getDishOptions: jest.fn().mockResolvedValue([]),
    };
  });

  it('finds a vendor through its items when its name does not say what it sells', async () => {
    // The real case: wigs sold by a vendor named "Jollof Pot", filed as a Restaurant.
    catalog.searchProducts.mockResolvedValue([wig]);
    const harvest = emptyHarvest();

    const output = await executeTool(
      'search_vendors',
      { query: 'hair', areaId: LEKKI },
      context(),
      harvest,
    );

    expect(catalog.searchProducts).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hair', areaId: LEKKI }),
    );
    // Shown as the items under their vendor, and their prices are allowed through.
    expect(harvest.products).toEqual([wig]);
    expect(harvest.prices).toContain(50000);
    const told = JSON.parse(output) as {
      matchedOn: string;
      items: { vendorName: string }[];
    };
    expect(told.matchedOn).toBe('items');
    expect(told.items[0].vendorName).toBe('Jollof Pot');
  });

  it('searches the thing, not "vendors", when the model passes the whole phrase', async () => {
    catalog.searchProducts.mockResolvedValue([wig]);

    await executeTool(
      'search_vendors',
      { query: 'hair vendors' },
      context(),
      emptyHarvest(),
    );

    expect(catalog.searchProducts).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hair' }),
    );
  });

  it('searches items for a category we do not have, like "hair"', async () => {
    catalog.searchProducts.mockResolvedValue([wig]);
    const harvest = emptyHarvest();

    await executeTool(
      'search_vendors',
      { category: 'hair' },
      context(),
      harvest,
    );

    expect(harvest.products).toEqual([wig]);
  });

  it('finds items even when no vendor of that kind serves the area', async () => {
    // "wig" is Beauty; the only seller is filed under Restaurant.
    catalog.listCategories.mockResolvedValue([
      { name: 'Restaurant', storeCount: 1 },
    ]);
    catalog.searchProducts.mockResolvedValue([wig]);
    const harvest = emptyHarvest();

    await executeTool(
      'search_vendors',
      { query: 'wig', category: 'Beauty' },
      context(),
      harvest,
    );

    expect(harvest.products).toEqual([wig]);
  });

  it('still shows a vendor matched by name as a vendor, without searching items', async () => {
    catalog.searchVendors.mockResolvedValue([grill]);
    const harvest = emptyHarvest();

    await executeTool(
      'search_vendors',
      { query: 'hair grill' },
      context(),
      harvest,
    );

    expect(harvest.vendors).toEqual([grill]);
    expect(harvest.products).toEqual([]);
    expect(catalog.searchProducts).not.toHaveBeenCalled();
  });

  it('says plainly when nothing matches by name or by item', async () => {
    const output = await executeTool(
      'search_vendors',
      { query: 'helicopter' },
      context(),
      emptyHarvest(),
    );

    expect(output).toBe(
      'No vendors match that, by name or by anything they sell.',
    );
  });
});

describe('withoutVendorWords', () => {
  it('keeps the thing and drops the words about who sells it', () => {
    expect(withoutVendorWords('hair vendors')).toBe('hair');
    expect(withoutVendorWords('shops selling wigs')).toBe('wigs');
    expect(withoutVendorWords('vendors')).toBe('');
    expect(withoutVendorWords(undefined)).toBe('');
  });
});
