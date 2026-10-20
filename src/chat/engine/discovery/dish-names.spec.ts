import { dishWords, searchVariants, searchWithDishNames } from './dish-names';
import type {
  CatalogPort,
  ProductSearchQuery,
  ProductSummary,
} from '../../ports/catalog.port';

const product = (name: string): ProductSummary => ({
  id: `p-${name}`,
  name,
  description: null,
  price: 2500,
  imageUrl: null,
  vendorId: 'v1',
  vendorName: 'Iya Basira Buka',
  vendorSlug: 'iya-basira',
  vendorIsOpen: true,
  vendorOpensAt: null,
  isAddOn: false,
});

/** Matches like the real search: every word, joining words ignored. */
function menu(...names: string[]): CatalogPort & { asked: string[] } {
  const asked: string[] = [];
  const items = names.map(product);
  return {
    asked,
    searchProducts: jest.fn((q: ProductSearchQuery) => {
      asked.push(q.text ?? '');
      const words = (q.text ?? '')
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 1 && w !== 'and');
      return Promise.resolve(
        items.filter((item) =>
          words.every((w) => item.name.toLowerCase().includes(w)),
        ),
      );
    }),
  } as unknown as CatalogPort & { asked: string[] };
}

describe('what buyers call a dish', () => {
  it('searches ewa agoyin as beans', () => {
    expect(searchVariants('ewa agoyin')).toEqual(['ewa agoyin', 'beans']);
  });

  it('reads the longer name first — "ewa agoyin" is one dish, not ewa plus agoyin', () => {
    expect(searchVariants('ewa agoyin')).not.toContain('beans agoyin');
  });

  it('turns every dish name in the search into vendors’ words', () => {
    expect(searchVariants('ewa and dodo')).toContain('beans and plantain');
  });

  it('tries each kind of swallow', () => {
    const variants = searchVariants('swallow and egusi');
    expect(variants[0]).toBe('swallow and egusi');
    expect(variants).toEqual(
      expect.arrayContaining([
        'amala and egusi',
        'eba and egusi',
        'semovita and egusi',
      ]),
    );
  });

  it('leaves a search with no dish names as it is', () => {
    expect(searchVariants('jollof rice')).toEqual(['jollof rice']);
  });

  it('does not read a dish name inside another word', () => {
    // "obe" is soup, but not inside "wardrobe".
    expect(searchVariants('wardrobe')).toEqual(['wardrobe']);
  });

  it('never fans out past eight', () => {
    expect(searchVariants('swallow ewa dodo obe').length).toBeLessThanOrEqual(
      8,
    );
  });

  it('gives the words a dish name stands for', () => {
    expect(dishWords('I want ewa agoyin')).toEqual(['beans']);
  });

  describe('searching', () => {
    it('finds the beans for ewa agoyin', async () => {
      const found = await searchWithDishNames(
        menu('Beans and Fried Plantain', 'Jollof Rice'),
        { text: 'ewa agoyin' },
      );
      expect(found.map((p) => p.name)).toEqual(['Beans and Fried Plantain']);
    });

    it('finds swallow on a menu that only names the kinds', async () => {
      const found = await searchWithDishNames(
        menu('Amala with Ewedu', 'Egusi Soup and Semovita', 'Jollof Rice'),
        { text: 'swallow' },
      );
      expect(found.map((p) => p.name)).toEqual([
        'Amala with Ewedu',
        'Egusi Soup and Semovita',
      ]);
    });

    it("searches the buyer's own words first, and stops once it has enough", async () => {
      const catalog = menu('Ewa Agoyin Special');
      const found = await searchWithDishNames(catalog, {
        text: 'ewa agoyin',
        limit: 1,
      });
      expect(found.map((p) => p.name)).toEqual(['Ewa Agoyin Special']);
      expect(catalog.asked).toEqual(['ewa agoyin']);
    });
  });
});
