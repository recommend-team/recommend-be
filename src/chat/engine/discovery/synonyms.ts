/**
 * The words buyers use, mapped to the categories vendors file themselves under.
 *
 * Buyers ask for a *kind* of thing — "food", "laptop", "air conditioner" — and vendors
 * name the specific thing they sell: "Jollof Rice & Beef", "HP Pavilion 15", "LG 1.5HP
 * Split Unit".
 *
 * The categories and their words belong to admins: `CategoryVocabularyService` reads
 * them from the database and hands them to `useCategoryWords`. Until it has, the
 * categories Recommend started with stand in.
 */
import {
  CATEGORIES,
  DEFAULT_CATEGORY_WORDS,
} from '../../../common/constants/default-categories';

export { CATEGORIES };

/** A category buyers can be pointed at, and the words they use for it. */
export interface CategoryWords {
  name: string;
  keywords: string[];
}

/** The categories Recommend started with — what the assistant knows before the database. */
export function defaultCategoryWords(): CategoryWords[] {
  return Object.entries(DEFAULT_CATEGORY_WORDS).map(([name, keywords]) => ({
    name,
    keywords,
  }));
}

/** Lowercase, letters and numbers only, single spaces — how buyers' words are read. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Built once per list — the lookup runs on every search that finds nothing. */
let NAMES: string[] = [];
let KEYWORDS = new Map<string, string[]>();
let SINGLE_WORD = new Map<string, string>();
let PHRASES: { phrase: string; category: string }[] = [];

/**
 * Point the assistant at a list of categories — the active ones admins keep in the
 * database. Called at startup and whenever an admin changes one. An empty list is
 * ignored: better yesterday's categories than none at all.
 *
 * Each category's own name counts as one of its words, so a category an admin has just
 * created, with no words yet, is still found when a buyer says its name.
 */
export function useCategoryWords(categories: CategoryWords[]): void {
  if (categories.length === 0) return;

  // Each word points at one category. Names claim theirs first, so a "Hair" category
  // gets "hair" even though Beauty lists it; then words, first category first.
  const owner = new Map<string, string>();
  const keywords = new Map<string, string[]>();
  for (const { name } of categories) {
    const own = normalise(name);
    if (own && !owner.has(own)) owner.set(own, name);
  }
  for (const { name, keywords: words } of categories) {
    const cleaned = words.map(normalise).filter(Boolean);
    keywords.set(name, cleaned);
    for (const word of cleaned) if (!owner.has(word)) owner.set(word, name);
  }

  const singleWord = new Map<string, string>();
  const phrases: { phrase: string; category: string }[] = [];
  for (const [word, category] of owner) {
    if (word.includes(' ')) phrases.push({ phrase: word, category });
    else singleWord.set(word, category);
  }
  // Longest first, so "rice cooker" is read before anything shorter inside it.
  phrases.sort((a, b) => b.phrase.length - a.phrase.length);

  NAMES = categories.map((category) => category.name);
  KEYWORDS = keywords;
  SINGLE_WORD = singleWord;
  PHRASES = phrases;
}

/** The categories the assistant currently offers, by name. */
export function categoryNames(): string[] {
  return NAMES;
}

useCategoryWords(defaultCategoryWords());

/** "wears" → "wear", "dresses" → "dress", "caps" → "cap"; other words as they are. */
function singular(word: string): string {
  if (word.length > 4 && /(ss|sh|ch|x)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * The standard categories a vendor's own category stands for. Vendors type it freely —
 * "food", "Barbecue, food", "Iphones, androids, ipads, etc" — so it is read with the
 * same words buyers use: "Barbecue, food" is a Restaurant.
 */
export function standardCategoriesOf(vendorCategory: string | null): string[] {
  if (!vendorCategory?.trim()) return [];
  const exact = NAMES.find(
    (category) =>
      category.toLowerCase() === vendorCategory.trim().toLowerCase(),
  );
  return exact ? [exact] : categoriesFor(vendorCategory);
}

/** "food, gadgets, phone accessories, home appliances, fashion or beauty" — for asking. */
export function kindsList(): string {
  const kinds = NAMES.map(spokenKind);
  if (kinds.length <= 1) return kinds[0] ?? 'anything';
  return `${kinds.slice(0, -1).join(', ')} or ${kinds[kinds.length - 1]}`;
}

/**
 * Which categories, if any, the buyer's words point at.
 */
export function categoriesFor(text: string | undefined): string[] {
  if (!text) return [];

  const normalised = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalised) return [];

  const found = new Set<string>();

  let rest = ` ${normalised} `;
  for (const { phrase, category } of PHRASES) {
    if (rest.includes(` ${phrase} `)) {
      found.add(category);
      rest = rest.split(` ${phrase} `).join(' ');
    }
  }

  for (const token of rest.trim().split(/\s+/)) {
    const category = SINGLE_WORD.get(token) ?? SINGLE_WORD.get(singular(token));
    if (category) found.add(category);
  }

  return [...found];
}

/**
 * Words that name only a kind of thing — "food", "clothes", "gadgets" — never one item.
 * Someone saying just these is browsing, not looking for a product called "food".
 */
const BROAD: Record<string, string[]> = {
  [CATEGORIES.restaurant]: [
    'food',
    'chop',
    'eat',
    'eating',
    'eatery',
    'restaurant',
    'canteen',
    'buka',
    'bukka',
    'mama put',
    'meal',
    'lunch',
    'dinner',
    'breakfast',
    'cooked food',
    'hot meal',
    'something to eat',
    'kitchen',
    'takeaway',
    'hungry',
    'starving',
    'famished',
  ],
  [CATEGORIES.gadgets]: ['gadget', 'electronics', 'tech', 'device'],
  [CATEGORIES.phoneAccessories]: [
    'accessory',
    'accessories',
    'phone accessories',
  ],
  [CATEGORIES.homeAppliances]: ['appliance', 'home appliances'],
  [CATEGORIES.fashion]: [
    'fashion',
    'clothes',
    'clothing',
    'wear',
    'outfit',
    'attire',
  ],
  [CATEGORIES.beauty]: [
    'beauty',
    'cosmetic',
    'cosmetics',
    'beauty products',
    'beauty supplies',
  ],
};

/** What a few of each kind are, for asking "what are you in the mood for?". */
const EXAMPLES: Record<string, string> = {
  [CATEGORIES.restaurant]: 'rice, swallow, grills or snacks',
  [CATEGORIES.gadgets]: 'a phone, a laptop or a tablet',
  [CATEGORIES.phoneAccessories]: 'a charger, earphones or a power bank',
  [CATEGORIES.homeAppliances]: 'a fridge, an AC or a blender',
  [CATEGORIES.fashion]: 'clothes, shoes, bags or caps',
  [CATEGORIES.beauty]: 'hair, makeup, skincare or perfume',
};

/**
 * The words around a broad request that say nothing about what is wanted — "I need
 * some …", "do you have any … vendors?", "abeg I'm hungry".
 */
const ASKING = new Set(
  (
    'i m am is are be a an the some any anything something me my we us you your u ' +
    'need needs want wanna would like love get buy order find looking look for to ' +
    'please pls plz abeg do does have has got sell sells selling show see can could ' +
    'there where what which who whats good nice hi hello hey oh ok okay now today ' +
    'right very so really just and of vendor vendors store stores shop shops seller ' +
    'sellers place places option options available feel feeling kind type sort ' +
    'around near nearby here'
  ).split(' '),
);

/** "in Ajah", "around Lekki phase 1" — where, not what. */
const PLACE_TAIL = /\b(?:in|at|around|near|for)\s+(?!to\b)[a-z0-9 ]*$/;

/**
 * The kind of thing, when the buyer asked only for a kind — "I need food", "any
 * clothes?", "I'm hungry" — and nothing in particular. Null when they named an item
 * ("I need jollof"), or more than one kind.
 */
export function broadKindOf(text: string | undefined): string | null {
  if (!text) return null;
  let rest = ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(PLACE_TAIL, '')
    .trim()} `;
  if (!rest.trim()) return null;

  const broad = broadWords();
  const kinds = new Set<string>();
  for (const [category, words] of broad) {
    for (const phrase of words.filter((word) => word.includes(' '))) {
      if (rest.includes(` ${phrase} `)) {
        kinds.add(category);
        rest = rest.split(` ${phrase} `).join(' ');
      }
    }
  }
  for (const token of rest.trim().split(/\s+/).filter(Boolean)) {
    const kind = broad.find(([, words]) =>
      words.some((word) => word === token || word === singular(token)),
    )?.[0];
    if (kind) kinds.add(kind);
    else if (!ASKING.has(token)) return null; // An item, or something else entirely.
  }
  return kinds.size === 1 ? [...kinds][0] : null;
}

/** How a buyer says a kind: "food", not "Restaurant". */
export function spokenKind(category: string): string {
  return category === CATEGORIES.restaurant ? 'food' : category.toLowerCase();
}

/**
 * The words that name each offered category as a whole — "food", "clothes". A category
 * an admin created has its own name: "pets", "pet".
 */
function broadWords(): [string, string[]][] {
  return NAMES.map((name) => {
    const own = normalise(name);
    return [name, BROAD[name] ?? [own, singular(own)]];
  });
}

/** "rice, swallow, grills or snacks" — a few of a kind, to ask which they fancy. */
export function examplesOf(category: string): string {
  const written = EXAMPLES[category];
  if (written) return written;
  // One an admin created: the first few of its own words.
  const own = normalise(category);
  const words = (KEYWORDS.get(category) ?? [])
    .filter((word) => word !== own)
    .slice(0, 3);
  if (words.length === 0) return 'anything in particular';
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}
