import type {
  CatalogPort,
  ProductSummary,
  VendorSummary,
} from '../../ports/catalog.port';
import { CATEGORIES, categoriesFor } from './synonyms';
import { dishWords } from './dish-names';

/**
 * What to offer when nothing matches what the buyer asked for.
 *
 * A dead end loses the buyer, so the nearest thing that is actually available is offered
 * instead — closest first, and never wandering further than it has to:
 *
 *   1. similar  — items with any of the words: "rice and beans" → Jollof Rice, Beans & Plantain
 *   2. category — other items of the same kind nearby: "laptop" → other gadgets
 *   3. vendors  — the vendors serving the area, when the kind of thing is unknown
 *   4. none     — nothing nearby at all
 *
 * A request whose kind is known never jumps to another kind: someone after a charger is
 * not shown jollof. Works by words and the vendors' own categories, so it holds for food,
 * gadgets and anything sold later alike.
 */
export type AlternativeKind = 'similar' | 'category' | 'vendors' | 'none';

export interface Alternatives {
  kind: AlternativeKind;
  products: ProductSummary[];
  vendors: VendorSummary[];
  /** The category behind a `category` result, for saying "other food near you". */
  category: string | null;
}

/** Enough to choose from, few enough to read in a chat. */
export const ALTERNATIVES_SHOWN = 8;

export async function findAlternatives(
  catalog: CatalogPort,
  query: { text: string; areaId?: string | null },
): Promise<Alternatives> {
  const areaId = query.areaId ?? undefined;

  // 1. Close matches: any of the words, and what any dish names in them stand for —
  // "ewa agoyin" also looks for beans. One word on its own is the same search again.
  const words = [query.text, ...dishWords(query.text)].join(' ');
  if (meaningfulWords(words) > 1) {
    const products = await catalog.searchProducts({
      text: words,
      matchAny: true,
      areaId,
      limit: ALTERNATIVES_SHOWN,
    });
    if (products.length > 0) {
      return { kind: 'similar', products, vendors: [], category: null };
    }
  }

  // 2. The same kind of thing. If the kind is known, it is also as far as this goes.
  const categories = categoriesFor(query.text);
  if (categories.length > 0) {
    const products = await catalog.searchProducts({
      categories,
      areaId,
      limit: ALTERNATIVES_SHOWN,
    });
    if (products.length > 0) {
      return {
        kind: 'category',
        products,
        vendors: [],
        category: categories[0],
      };
    }

    const vendors = await catalog.searchVendors({
      categories,
      areaId,
      limit: ALTERNATIVES_SHOWN,
    });
    return vendors.length > 0
      ? { kind: 'vendors', products: [], vendors, category: categories[0] }
      : none();
  }

  // 3. The kind is unknown: who serves the area. Without an area that would be every
  // vendor anywhere, which is not a recommendation.
  if (areaId) {
    const vendors = await catalog.searchVendors({
      areaId,
      limit: ALTERNATIVES_SHOWN,
    });
    if (vendors.length > 0) {
      return { kind: 'vendors', products: [], vendors, category: null };
    }
  }

  return none();
}

/**
 * The opening line for alternatives — always saying first that they are not what was
 * asked for, so nobody orders a different charger thinking it is theirs.
 */
export function alternativesLine(
  found: Alternatives,
  asked: string,
  place: string | null,
): string {
  const where = place ? ` in ${place}` : '';
  const what = `"${asked}"`;

  switch (found.kind) {
    case 'similar':
      return `I couldn't find ${what}${where}, but these are close:`;
    case 'category':
      return `I couldn't find ${what}${where}, but here's other ${kindOf(found.category)} near you:`;
    case 'vendors':
      return found.category
        ? `I couldn't find ${what}${where}, but these ${kindOf(found.category)} vendors are near you — tap one to see what they have:`
        : `I couldn't find ${what}${where}, but these vendors deliver there — tap one to see what they have:`;
    case 'none':
      return `I couldn't find ${what}${where}. Try another search, or tell me which area you're in.`;
  }
}

/** How a buyer would say a category: "food", not "Restaurant". */
function kindOf(category: string | null): string {
  if (!category) return 'options';
  if (category === CATEGORIES.restaurant) return 'food';
  return category.toLowerCase();
}

function none(): Alternatives {
  return { kind: 'none', products: [], vendors: [], category: null };
}

/** Words that could match an item — joining words like "and" do not count. */
function meaningfulWords(text: string): number {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !JOINING.has(word)).length;
}

const JOINING = new Set(['and', 'with', 'or', 'of', 'the', 'some']);
