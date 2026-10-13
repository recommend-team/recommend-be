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
    'android',
    'iphone',
    'tablet',
    'ipad',
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
    'fan',
    'standing fan',
    'tv',
    'television',
    'washing machine',
    'water dispenser',
    'pressing iron',
    'kettle',
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

  for (const { phrase, category } of PHRASES) {
    if (normalised.includes(phrase)) found.add(category);
  }

  for (const token of normalised.split(' ')) {
    const category = SINGLE_WORD.get(token);
    if (category) found.add(category);
  }

  return [...found];
}
