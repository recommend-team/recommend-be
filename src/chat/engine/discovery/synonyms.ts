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
    const category = SINGLE_WORD.get(token);
    if (category) found.add(category);
  }

  return [...found];
}
