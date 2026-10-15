import type { CatalogPort, ProductSummary } from '../../ports/catalog.port';

/**
 * What buyers call a dish, mapped to the words vendors put in its name.
 *
 * Search matches the words in product names, and nobody's menu says "ewa agoyin" — it
 * says "Beans and Fried Plantain". Each name here is searched as the words it stands
 * for, so the buyer who asks for ewa agoyin finds the beans.
 *
 * Kept short and certain: every entry is what the dish is, not what goes with it. Add to
 * it from the unmet-search log, which shows what buyers actually typed.
 */
const DISH_NAMES: Record<string, string[]> = {
  'ewa agoyin': ['beans'],
  ewa: ['beans'],
  agoyin: ['beans'],
  'moin moin': ['moi moi'],
  moinmoin: ['moi moi'],
  dodo: ['plantain'],
  bole: ['plantain'],
  boli: ['plantain'],
  iresi: ['rice'],
  swallow: ['amala', 'eba', 'fufu', 'semo', 'semovita', 'pounded yam', 'wheat'],
  obe: ['soup'],
  ofe: ['soup'],
  'isi ewu': ['goat head'],
  asun: ['goat meat'],
  gizdodo: ['gizzard'],
};

/** Longest first, so "ewa agoyin" is read as one dish before "ewa" alone. */
const PHRASES = Object.keys(DISH_NAMES).sort((a, b) => b.length - a.length);

/** At most this many ways of saying one search, so "swallow and..." cannot fan out far. */
const MAX_VARIANTS = 8;

/**
 * The buyer's words, then the same search in vendors' words: "ewa agoyin and dodo" →
 * ["ewa agoyin and dodo", "beans and dodo", "beans and plantain", ...]. The original
 * always comes first, and is the only entry when no dish name appears in it.
 */
export function searchVariants(text: string): string[] {
  const variants = [text];
  let frontier = [normalise(text)];

  for (const phrase of PHRASES) {
    const next: string[] = [];
    for (const current of frontier) {
      const pattern = new RegExp(`\\b${escape(phrase)}\\b`);
      if (!pattern.test(current)) {
        next.push(current);
        continue;
      }
      for (const meaning of DISH_NAMES[phrase]) {
        next.push(current.replace(pattern, meaning));
      }
    }
    frontier = next.slice(0, MAX_VARIANTS);
  }

  for (const variant of frontier) {
    if (!variants.some((v) => normalise(v) === variant)) variants.push(variant);
  }
  return variants.slice(0, MAX_VARIANTS);
}

/** The words the dish names in `text` stand for — to widen a close-match search. */
export function dishWords(text: string): string[] {
  let said = normalise(text);
  const words = new Set<string>();

  // Longest first, and each match taken out of the text, so "ewa agoyin" is one dish
  // rather than also "ewa" and "agoyin" again.
  for (const phrase of PHRASES) {
    const pattern = new RegExp(`\\b${escape(phrase)}\\b`, 'g');
    if (!pattern.test(said)) continue;
    DISH_NAMES[phrase].forEach((word) => words.add(word));
    said = said.replace(pattern, ' ');
  }

  return [...words];
}

/**
 * Search the buyer's words, then each way of saying them in vendors' words, until there
 * is something — gathering up to `limit`. Exact matches for the buyer's own words come
 * first.
 */
export async function searchWithDishNames(
  catalog: CatalogPort,
  query: { text: string; areaId?: string; limit?: number },
): Promise<ProductSummary[]> {
  const limit = query.limit ?? 8;
  const found: ProductSummary[] = [];

  for (const text of searchVariants(query.text)) {
    const products = await catalog.searchProducts({
      text,
      areaId: query.areaId,
      limit,
    });
    for (const product of products) {
      if (!found.some((p) => p.id === product.id)) found.push(product);
    }
    if (found.length >= limit) break;
  }

  return found.slice(0, limit);
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
