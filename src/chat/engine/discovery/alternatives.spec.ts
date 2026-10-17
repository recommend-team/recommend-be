import { alternativesLine, findAlternatives } from './alternatives';
import { emptyHarvest, executeTool } from './tools';
import { UnmetSearchService } from './unmet-search.service';
import type {
  CatalogPort,
  ProductSearchQuery,
  ProductSummary,
  VendorSearchQuery,
  VendorSummary,
} from '../../ports/catalog.port';

const product = (name: string, vendorName = 'Mama Put'): ProductSummary => ({
  id: `p-${name}`,
  name,
  description: null,
  price: 2500,
  imageUrl: null,
  vendorId: 'v1',
  vendorName,
  vendorSlug: 'mama-put',
  isAddOn: false,
});

const vendor = (name: string, category: string): VendorSummary => ({
  id: `v-${name}`,
  name,
  slug: name.toLowerCase(),
  category,
  areas: [{ id: 'ajah', name: 'Ajah' }],
  isOpen: true,
  logoUrl: null,
});

/**
 * A small catalogue in Ajah: food from one kitchen, chargers from one shop. Searches
 * behave like the real ones — all words, any word, by category, by area.
 */
function catalogue(): CatalogPort & {
  productQueries: ProductSearchQuery[];
  vendorQueries: VendorSearchQuery[];
} {
  const items = [
    { ...product('Jollof Rice'), category: 'Restaurant' },
    { ...product('Beans and Plantain'), category: 'Restaurant' },
    { ...product('Pepper Soup'), category: 'Restaurant' },
    {
      ...product('iPhone Fast Charger', 'Gadget Hub'),
      category: 'Phone Accessories',
    },
  ];
  const vendors = [
    vendor('Mama Put', 'Restaurant'),
    vendor('Gadget Hub', 'Phone Accessories'),
  ];
  const words = (text?: string) =>
    (text ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 1 &&
          !['and', 'with', 'or', 'of', 'the', 'some'].includes(w),
      );

  const productQueries: ProductSearchQuery[] = [];
  const vendorQueries: VendorSearchQuery[] = [];

  return {
    productQueries,
    vendorQueries,
    listCategories: jest.fn(),
    getVendorById: jest.fn(),
    getProductById: jest.fn(),
    listAddOns: jest.fn(),
    getDishOptions: jest.fn().mockResolvedValue([]),
    searchProducts: jest.fn((q: ProductSearchQuery) => {
      productQueries.push(q);
      const tokens = words(q.text);
      return Promise.resolve(
        items
          .filter((item) => {
            const name = item.name.toLowerCase();
            const hit = (t: string) => name.includes(t);
            if (q.categories && !q.categories.includes(item.category))
              return false;
            if (tokens.length === 0) return true;
            return q.matchAny ? tokens.some(hit) : tokens.every(hit);
          })
          .slice(0, q.limit ?? 8),
      );
    }),
    searchVendors: jest.fn((q: VendorSearchQuery) => {
      vendorQueries.push(q);
      return Promise.resolve(
        vendors.filter(
          (v) =>
            (!q.categories || q.categories.includes(v.category ?? '')) &&
            (!q.text || v.name.toLowerCase().includes(q.text.toLowerCase())),
        ),
      );
    }),
  };
}

describe('offering something when nothing matches', () => {
  it('offers close matches first — any of the words', async () => {
    const found = await findAlternatives(catalogue(), {
      text: 'rice and beans',
      areaId: 'ajah',
    });

    expect(found.kind).toBe('similar');
    expect(found.products.map((p) => p.name)).toEqual([
      'Jollof Rice',
      'Beans and Plantain',
    ]);
  });

  it('then other things of the same kind', async () => {
    // "food" names a kind, not an item: nothing is called "amala food", but there is food.
    const found = await findAlternatives(catalogue(), {
      text: 'amala food',
      areaId: 'ajah',
    });

    expect(found.kind).toBe('category');
    expect(found.category).toBe('Restaurant');
    expect(found.products.every((p) => p.vendorName === 'Mama Put')).toBe(true);
  });

  it('never jumps to another kind of thing for a request whose kind is known', async () => {
    const catalog = catalogue();
    (catalog.searchProducts as jest.Mock).mockResolvedValue([]);
    (catalog.searchVendors as jest.Mock).mockResolvedValue([]);

    // A laptop is a gadget; with no gadgets nearby, food is not an answer.
    const found = await findAlternatives(catalog, {
      text: 'laptop',
      areaId: 'ajah',
    });

    expect(found.kind).toBe('none');
    expect(catalog.vendorQueries.every((q) => q.categories?.length)).toBe(true);
  });

  it('understands a local dish name — ewa agoyin is beans', async () => {
    const found = await findAlternatives(catalogue(), {
      text: 'ewa agoyin',
      areaId: 'ajah',
    });

    expect(found.kind).toBe('similar');
    expect(found.products.map((p) => p.name)).toEqual(['Beans and Plantain']);
  });

  it('offers the vendors serving the area when the kind is unknown', async () => {
    const found = await findAlternatives(catalogue(), {
      text: 'chilled zobo',
      areaId: 'ajah',
    });

    expect(found.kind).toBe('vendors');
    expect(found.vendors.map((v) => v.name)).toEqual([
      'Mama Put',
      'Gadget Hub',
    ]);
  });

  it('does not list every vendor anywhere when the area is unknown', async () => {
    const found = await findAlternatives(catalogue(), {
      text: 'chilled zobo',
      areaId: null,
    });

    expect(found.kind).toBe('none');
  });

  it('skips the any-word search for a single word — it would be the same search', async () => {
    const catalog = catalogue();
    await findAlternatives(catalog, { text: 'ofada', areaId: 'ajah' });

    expect(catalog.productQueries.some((q) => q.matchAny)).toBe(false);
  });

  it('keeps to eight', async () => {
    const catalog = catalogue();
    await findAlternatives(catalog, { text: 'rice and beans', areaId: 'ajah' });

    expect(catalog.productQueries.every((q) => q.limit === 8)).toBe(true);
  });

  describe('what the buyer is told', () => {
    it('always says first that it is not what they asked for', () => {
      const line = alternativesLine(
        { kind: 'similar', products: [], vendors: [], category: null },
        'rice and beans',
        'Ajah',
      );
      expect(line).toBe(
        `I couldn't find "rice and beans" in Ajah, but these are close:`,
      );
    });

    it('names the kind the way a buyer would', () => {
      expect(
        alternativesLine(
          {
            kind: 'category',
            products: [],
            vendors: [],
            category: 'Restaurant',
          },
          'amala',
          'Ajah',
        ),
      ).toBe(
        `I couldn't find "amala" in Ajah, but here's other food near you:`,
      );
    });
  });
});

describe('the assistant searching', () => {
  it('gets the alternatives, marked as not an exact match, and the buyer sees them', async () => {
    const harvest = emptyHarvest();
    const answer = await executeTool(
      'search_products',
      {
        query: 'rice and beans',
        areaId: 'f3c1c3a0-0000-4000-8000-000000000001',
      },
      { catalog: catalogue(), locations: {} as never, areaId: null },
      harvest,
    );

    const parsed = JSON.parse(answer) as { exactMatch: boolean; note: string };
    expect(parsed.exactMatch).toBe(false);
    expect(parsed.note).toMatch(/could not find exactly/);
    expect(harvest.products.map((p) => p.name)).toContain('Jollof Rice');
    expect(harvest.unmet).toEqual([
      {
        query: 'rice and beans',
        areaId: 'f3c1c3a0-0000-4000-8000-000000000001',
        alternatives: 'similar',
      },
    ]);
  });

  it('records nothing when the search matched', async () => {
    const harvest = emptyHarvest();
    await executeTool(
      'search_products',
      { query: 'jollof rice' },
      { catalog: catalogue(), locations: {} as never, areaId: null },
      harvest,
    );

    expect(harvest.unmet).toEqual([]);
  });
});

describe('the unmet-search log', () => {
  it('records each want once per turn, trimmed', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const service = new UnmetSearchService({ insert } as never);

    await service.record(
      [
        {
          query: '  rice  and beans ',
          areaId: 'ajah',
          alternatives: 'similar',
        },
        { query: 'Rice and beans', areaId: 'ajah', alternatives: 'similar' },
      ],
      'conv-1',
    );

    expect(insert).toHaveBeenCalledWith([
      {
        query: 'rice and beans',
        areaId: 'ajah',
        alternatives: 'similar',
        conversationId: 'conv-1',
      },
    ]);
  });

  it('never throws — the buyer already has their answer', async () => {
    const service = new UnmetSearchService({
      insert: jest.fn().mockRejectedValue(new Error('db down')),
    } as never);

    await expect(
      service.record([{ query: 'suya', areaId: null, alternatives: 'none' }]),
    ).resolves.toBeUndefined();
  });
});

describe('the assistant reading a menu', () => {
  it('learns what each dish comes with, by name — never what it costs', async () => {
    const catalog = catalogue();
    (catalog.getDishOptions as jest.Mock).mockImplementation((ids: string[]) =>
      Promise.resolve(
        ids.slice(0, 1).map((productId) => ({
          productId,
          name: 'Jollof Rice',
          unit: 'portion',
          choices: [
            {
              id: 'g1',
              name: 'Choose your protein',
              required: true,
              minPick: 1,
              maxPick: 1,
              options: [
                { id: 'o1', name: 'Chicken', priceDelta: 0, isAvailable: true },
                { id: 'o2', name: 'Goat', priceDelta: 500, isAvailable: false },
              ],
            },
          ],
          extras: [{ id: 'w1', name: 'Water', price: 300 }],
        })),
      ),
    );

    const answer = await executeTool(
      'search_products',
      { query: 'jollof rice' },
      { catalog, locations: {} as never, areaId: null },
      emptyHarvest(),
    );

    const [dish] = JSON.parse(answer) as Record<string, unknown>[];
    expect(dish).toMatchObject({
      soldPer: 'portion',
      choices: [
        {
          name: 'Choose your protein',
          required: true,
          pickUpTo: 1,
          options: ['Chicken'],
        },
      ],
      extras: ['Water'],
    });
    // Neither the option's extra cost nor the extra's price reaches the model.
    expect(answer).not.toMatch(/\b(500|300)\b/);
  });
});
