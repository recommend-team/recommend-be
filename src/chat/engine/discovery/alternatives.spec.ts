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
  vendorIsOpen: true,
  vendorOpensAt: null,
  isAddOn: false,
});

const vendor = (name: string, category: string): VendorSummary => ({
  id: `v-${name}`,
  name,
  slug: name.toLowerCase(),
  category,
  areas: [{ id: 'ajah', name: 'Ajah' }],
  isOpen: true,
  opensAt: null,
  logoUrl: null,
});

/**
 * A small catalogue in Ajah: food from two kitchens (one filed as "Barbecue, food"),
 * chargers from one shop, a rice cooker from another. Searches behave like the real ones
 * — all words, any word, by category, by area.
 */
function catalogue(): CatalogPort & {
  productQueries: ProductSearchQuery[];
  vendorQueries: VendorSearchQuery[];
} {
  const items = [
    { ...product('Jollof Rice'), category: 'Restaurant' },
    { ...product('Beans and Plantain'), category: 'Restaurant' },
    { ...product('Pepper Soup'), category: 'Restaurant' },
    { ...product('Grilled Fish', 'Bisi Grills'), category: 'Barbecue, food' },
    {
      ...product('iPhone Fast Charger', 'Gadget Hub'),
      category: 'Phone Accessories',
    },
    { ...product('Rice Cooker', 'Home Plus'), category: 'Home Appliances' },
  ];
  const vendors = [
    vendor('Mama Put', 'Restaurant'),
    vendor('Bisi Grills', 'Barbecue, food'),
    vendor('Gadget Hub', 'Phone Accessories'),
    vendor('Home Plus', 'Home Appliances'),
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
    // As vendors typed them, counted.
    listCategories: jest.fn(() =>
      Promise.resolve(
        vendors.map((v) => ({ name: v.category ?? '', storeCount: 1 })),
      ),
    ),
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
    // Food only — both kitchens, never the shops.
    expect(
      found.products.every((p) =>
        ['Mama Put', 'Bisi Grills'].includes(p.vendorName ?? ''),
      ),
    ).toBe(true);
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

  it('asks what kind of thing, rather than list every vendor, when it cannot tell', async () => {
    const catalog = catalogue();
    const found = await findAlternatives(catalog, {
      text: 'kente',
      areaId: 'ajah',
    });

    expect(found.kind).toBe('ask');
    expect(found.vendors).toEqual([]);
    expect(catalog.vendorQueries).toEqual([]);
    expect(alternativesLine(found, 'kente', 'Ajah')).toBe(
      `I couldn't find "kente" in Ajah. What kind of thing is it — food, gadgets, phone accessories, home appliances or fashion? Then I can show you who has that near you.`,
    );
  });

  it('someone hungry is shown food vendors only — never the shops nearby', async () => {
    const catalog = catalogue();
    (catalog.searchProducts as jest.Mock).mockResolvedValue([]);

    // "ofada" alone says nothing; "I'm hungry" a message ago says it's food.
    const found = await findAlternatives(catalog, {
      text: 'ofada',
      areaId: 'ajah',
      said: "ofada I'm hungry",
    });

    expect(found.kind).toBe('vendors');
    expect(found.vendors.map((v) => v.name)).toEqual([
      'Mama Put',
      'Bisi Grills',
    ]);
  });

  it('never offers a rice cooker for fried rice', async () => {
    const found = await findAlternatives(catalogue(), {
      text: 'fried rice and chicken',
      areaId: 'ajah',
    });

    expect(found.kind).toBe('similar');
    expect(found.products.map((p) => p.name)).toEqual(['Jollof Rice']);
  });

  it('counts a vendor filed as "Barbecue, food" as food', async () => {
    const found = await findAlternatives(catalogue(), {
      text: 'suya',
      areaId: 'ajah',
    });

    expect(found.kind).toBe('category');
    expect(found.products.map((p) => p.vendorName)).toContain('Bisi Grills');
    expect(found.products.map((p) => p.name)).not.toContain('Rice Cooker');
  });

  it('says so when no vendor of that kind serves the area', async () => {
    const found = await findAlternatives(catalogue(), {
      text: 'ankara gown',
      areaId: 'ajah',
    });

    expect(found).toMatchObject({ kind: 'none', category: 'Fashion' });
    expect(alternativesLine(found, 'ankara gown', 'Ajah')).toBe(
      `I couldn't find "ankara gown" in Ajah, and no fashion vendors serve there yet. Try another area, or another search.`,
    );
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
        `I don't see "rice and beans" itself in Ajah, but these are close:`,
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
        `I don't see "amala" listed by name in Ajah, but here are some other food options near you:`,
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
    expect(parsed.note).toMatch(/don't see "rice and beans" itself/);
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

describe('the assistant asked for a kind of thing', () => {
  const AREA = 'f3c1c3a0-0000-4000-8000-000000000001';

  it('shows who sells it, as a normal answer — never "could not find"', async () => {
    const catalog = catalogue();
    const harvest = emptyHarvest();
    const answer = await executeTool(
      'search_products',
      { query: 'food' },
      { catalog, locations: {} as never, areaId: AREA },
      harvest,
    );

    const parsed = JSON.parse(answer) as {
      broadRequest: boolean;
      note: string;
      exactMatch?: boolean;
    };
    expect(parsed.broadRequest).toBe(true);
    expect(parsed.exactMatch).toBeUndefined();
    expect(parsed.note).toMatch(/never say you could not find/);
    // Both kitchens, however they filed themselves — and only food.
    expect(harvest.vendors.map((v) => v.name).sort()).toEqual([
      'Bisi Grills',
      'Mama Put',
    ]);
    // Not a product search for "food", and not a want we failed to meet.
    expect(catalog.productQueries).toEqual([]);
    expect(harvest.unmet).toEqual([]);
  });

  it('asks what they fancy and where they are when the area is not known', async () => {
    const catalog = catalogue();
    const harvest = emptyHarvest();
    const answer = await executeTool(
      'search_products',
      { query: 'food' },
      { catalog, locations: {} as never, areaId: null },
      harvest,
    );

    const parsed = JSON.parse(answer) as { note: string };
    expect(parsed.note).toMatch(/which area they are in/);
    expect(catalog.vendorQueries).toEqual([]);
    expect(harvest.vendors).toEqual([]);
  });

  it('says kindly when nobody sells it in the area', async () => {
    const harvest = emptyHarvest();
    const answer = await executeTool(
      'search_products',
      { query: 'clothes' },
      { catalog: catalogue(), locations: {} as never, areaId: AREA },
      harvest,
    );

    expect((JSON.parse(answer) as { note: string }).note).toMatch(
      /No vendors selling fashion serve their area yet/,
    );
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
