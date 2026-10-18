import type {
  CatalogPort,
  ProductSummary,
  VendorSummary,
} from '../../ports/catalog.port';
import {
  CATEGORIES,
  categoriesFor,
  kindsList,
  standardCategoriesOf,
} from './synonyms';
import { dishWords } from './dish-names';

/**
 * What to offer when nothing matches what the buyer asked for.
 *
 * A dead end loses the buyer, so the nearest thing that is actually available is offered
 * instead — closest first, and never wandering further than it has to:
 *
 *   1. similar  — items with any of the words: "rice and beans" → Jollof Rice, Beans & Plantain
 *   2. category — other items of the same kind nearby: "laptop" → other gadgets
 *   3. vendors  — vendors of that kind serving the area, when none has a similar item
 *   4. ask      — the kind of thing can't be told: ask, rather than list every vendor
 *   5. none     — nothing of that kind nearby at all
 *
 * **Every step stays inside the kind of thing asked for.** Someone hungry is shown food
 * vendors only — never the gadget shop down the road — and "fried rice" never turns up a
 * rice cooker. The kind is read from what the buyer is saying now and just said ("I'm
 * hungry… ofada"), and matched against vendors' own categories however they typed them.
 */
export type AlternativeKind =
  | 'similar'
  | 'category'
  | 'vendors'
  | 'ask'
  | 'none';

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
  query: {
    text: string;
    areaId?: string | null;
    /**
     * What the buyer has been saying — this message and the last few. "I'm hungry" two
     * messages ago says what kind of thing "ofada" is.
     */
    said?: string;
  },
): Promise<Alternatives> {
  const areaId = query.areaId ?? undefined;
  const wanted = kindOfRequest(query.text, query.said);
  const words = [query.text, ...dishWords(query.text)].join(' ');

  if (wanted.length === 0) {
    // The kind can't be told. Items sharing a word are still worth offering — they
    // are about the thing itself — but never a list of whoever serves the area.
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
    return { kind: 'ask', products: [], vendors: [], category: null };
  }

  // Vendors file themselves under whatever they typed; these are the ones, nearby, that
  // sell this kind of thing. None at all: nothing of the kind is near.
  const categories = await vendorCategoriesFor(catalog, wanted, areaId);
  if (categories.length === 0) return none(wanted[0]);

  // 1. Close matches of the same kind: any of the words, and what any dish names in
  // them stand for — "ewa agoyin" also looks for beans.
  if (meaningfulWords(words) > 1) {
    const products = await catalog.searchProducts({
      text: words,
      matchAny: true,
      categories,
      areaId,
      limit: ALTERNATIVES_SHOWN,
    });
    if (products.length > 0) {
      return { kind: 'similar', products, vendors: [], category: wanted[0] };
    }
  }

  // 2. Anything else of that kind nearby.
  const products = await catalog.searchProducts({
    categories,
    areaId,
    limit: ALTERNATIVES_SHOWN,
  });
  if (products.length > 0) {
    return { kind: 'category', products, vendors: [], category: wanted[0] };
  }

  // 3. Vendors of that kind, whose menus may say it differently.
  const vendors = await catalog.searchVendors({
    categories,
    areaId,
    limit: ALTERNATIVES_SHOWN,
  });
  return vendors.length > 0
    ? { kind: 'vendors', products: [], vendors, category: wanted[0] }
    : none(wanted[0]);
}

/**
 * The kind of thing being asked for: from the search itself, else from what the buyer
 * has been saying. The search wins — "a charger" after "I'm hungry" is a charger.
 */
export function kindOfRequest(text: string, said?: string): string[] {
  const fromSearch = categoriesFor(text);
  return fromSearch.length > 0 ? fromSearch : categoriesFor(said);
}

/**
 * The vendor categories, as vendors typed them, that stand for these kinds — among the
 * vendors serving the area. "Restaurant", "food" and "Barbecue, food" are all food.
 */
export async function vendorCategoriesFor(
  catalog: CatalogPort,
  kinds: string[],
  areaId?: string,
): Promise<string[]> {
  const typed = await catalog.listCategories({ areaId });
  return typed
    .map((category) => category.name)
    .filter((name) =>
      standardCategoriesOf(name).some((kind) => kinds.includes(kind)),
    );
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
    case 'ask':
      return `I couldn't find ${what}${where}. What kind of thing is it — ${kindsList()}? Then I can show you who has that near you.`;
    case 'category':
      return `I couldn't find ${what}${where}, but here's other ${kindOf(found.category)} near you:`;
    case 'vendors':
      return found.category
        ? `I couldn't find ${what}${where}, but these ${kindOf(found.category)} vendors are near you — tap one to see what they have:`
        : `I couldn't find ${what}${where}, but these vendors deliver there — tap one to see what they have:`;
    case 'none':
      return found.category
        ? `I couldn't find ${what}${where}, and no ${kindOf(found.category)} vendors serve there yet. Try another area, or another search.`
        : `I couldn't find ${what}${where}. Try another search, or tell me which area you're in.`;
  }
}

/** How a buyer would say a category: "food", not "Restaurant". */
function kindOf(category: string | null): string {
  if (!category) return 'options';
  if (category === CATEGORIES.restaurant) return 'food';
  return category.toLowerCase();
}

/** Nothing to offer — of this kind, when the kind is known. */
function none(category: string | null = null): Alternatives {
  return { kind: 'none', products: [], vendors: [], category };
}

/** Words that could match an item — joining words like "and" do not count. */
function meaningfulWords(text: string): number {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !JOINING.has(word)).length;
}

const JOINING = new Set(['and', 'with', 'or', 'of', 'the', 'some']);
