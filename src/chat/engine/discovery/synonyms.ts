/**
 * The words buyers use, mapped to the categories vendors file themselves under.
 *
 * Buyers ask for a *kind* of thing — "food", "laptop", "air conditioner" — and vendors
 * name the specific thing they sell: "Jollof Rice & Beef", "HP Pavilion 15", "LG 1.5HP
 * Split Unit".
 */

/** Canonical `businessCategory` values, as they appear in the database. */
export const CATEGORIES = {
  restaurant: 'Restaurant',
  gadgets: 'Gadgets',
  phoneAccessories: 'Phone Accessories',
  homeAppliances: 'Home Appliances',
  fashion: 'Fashion',
} as const;

const SYNONYMS: Record<string, string[]> = {
  [CATEGORIES.restaurant]: [
    'food',
    'foods',
    'chop',
    'eat',
    'eating',
    'eatery',
    'restaurant',
    'restaurants',
    'canteen',
    'buka',
    'bukka',
    'mama put',
    'meal',
    'meals',
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
    'barbecue',
    'bbq',
    'grill',
    'grills',
    // Dishes: someone asking for one wants food, whatever the menu calls it.
    'rice',
    'jollof',
    'fried rice',
    'ofada',
    'native rice',
    'amala',
    'eba',
    'fufu',
    'semo',
    'semovita',
    'pounded yam',
    'swallow',
    'soup',
    'egusi',
    'efo',
    'ogbono',
    'okra',
    'banga',
    'afang',
    'edikaikong',
    'pepper soup',
    'beans',
    'ewa',
    'agoyin',
    'plantain',
    'dodo',
    'boli',
    'bole',
    'moi moi',
    'moin moin',
    'akara',
    'yam',
    'porridge',
    'suya',
    'asun',
    'isi ewu',
    'nkwobi',
    'gizdodo',
    'shawarma',
    'burger',
    'burgers',
    'pizza',
    'sandwich',
    'chicken',
    'turkey',
    'goat meat',
    'fish',
    'catfish',
    'spaghetti',
    'noodles',
    'indomie',
    'small chops',
    'puff puff',
    'meat pie',
    'pastries',
    'snacks',
    'zobo',
    'chapman',
    'smoothie',
  ],
  [CATEGORIES.gadgets]: [
    'gadget',
    'gadgets',
    'laptop',
    'laptops',
    'computer',
    'computers',
    'pc',
    'notebook',
    'phone',
    'phones',
    'smartphone',
    'smartphones',
    'android',
    'androids',
    'iphone',
    'iphones',
    'tablet',
    'tablets',
    'ipad',
    'ipads',
    'electronics',
    'tech',
    'device',
    'devices',
  ],
  [CATEGORIES.phoneAccessories]: [
    'accessory',
    'accessories',
    'charger',
    'chargers',
    'cable',
    'cables',
    'earphone',
    'earphones',
    'earpiece',
    'headphone',
    'headphones',
    'airpods',
    'powerbank',
    'power bank',
    'phone case',
    'phone pouch',
    'screen guard',
    'screen protector',
    'memory card',
  ],
  [CATEGORIES.homeAppliances]: [
    'appliance',
    'appliances',
    'fridge',
    'fridges',
    'refrigerator',
    'freezer',
    'ac',
    'air conditioner',
    'air conditioning',
    'blender',
    'microwave',
    'oven',
    'cooker',
    'gas cooker',
    'rice cooker',
    'fan',
    'standing fan',
    'tv',
    'television',
    'washing machine',
    'water dispenser',
    'pressing iron',
    'kettle',
  ],
  [CATEGORIES.fashion]: [
    'fashion',
    'clothes',
    'clothing',
    'wear',
    'outfit',
    'outfits',
    'dress',
    'dresses',
    'gown',
    'gowns',
    'shirt',
    'shirts',
    't shirt',
    'tshirt',
    'top',
    'tops',
    'trouser',
    'trousers',
    'jeans',
    'skirt',
    'skirts',
    'ankara',
    'aso ebi',
    'agbada',
    'kaftan',
    'senator',
    'shoe',
    'shoes',
    'sneakers',
    'sandals',
    'slippers',
    'heels',
    'bag',
    'bags',
    'handbag',
    'cap',
    'hat',
    'wig',
    'wigs',
    'jewellery',
    'jewelry',
  ],
};

/** Built once — the lookup runs on every search that finds nothing. */
const SINGLE_WORD = new Map<string, string>();
const PHRASES: { phrase: string; category: string }[] = [];

for (const [category, words] of Object.entries(SYNONYMS)) {
  for (const word of words) {
    if (word.includes(' ')) PHRASES.push({ phrase: word, category });
    else SINGLE_WORD.set(word, category);
  }
}
// Longest first, so "rice cooker" is read before anything shorter inside it.
PHRASES.sort((a, b) => b.phrase.length - a.phrase.length);

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
  const exact = Object.values(CATEGORIES).find(
    (category) =>
      category.toLowerCase() === vendorCategory.trim().toLowerCase(),
  );
  return exact ? [exact] : categoriesFor(vendorCategory);
}

/** "food, gadgets, phone accessories, home appliances or fashion" — for asking. */
export function kindsList(): string {
  const kinds = Object.values(CATEGORIES).map((category) =>
    category === CATEGORIES.restaurant ? 'food' : category.toLowerCase(),
  );
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
};

/** What a few of each kind are, for asking "what are you in the mood for?". */
const EXAMPLES: Record<string, string> = {
  [CATEGORIES.restaurant]: 'rice, swallow, grills or snacks',
  [CATEGORIES.gadgets]: 'a phone, a laptop or a tablet',
  [CATEGORIES.phoneAccessories]: 'a charger, earphones or a power bank',
  [CATEGORIES.homeAppliances]: 'a fridge, an AC or a blender',
  [CATEGORIES.fashion]: 'clothes, shoes, bags or caps',
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

  const kinds = new Set<string>();
  for (const [category, words] of Object.entries(BROAD)) {
    for (const phrase of words.filter((word) => word.includes(' '))) {
      if (rest.includes(` ${phrase} `)) {
        kinds.add(category);
        rest = rest.split(` ${phrase} `).join(' ');
      }
    }
  }
  for (const token of rest.trim().split(/\s+/).filter(Boolean)) {
    const kind = Object.entries(BROAD).find(([, words]) =>
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

/** "rice, swallow, grills or snacks" — a few of a kind, to ask which they fancy. */
export function examplesOf(category: string): string {
  return EXAMPLES[category] ?? 'anything in particular';
}
