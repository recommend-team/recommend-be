import { CATEGORIES, categoriesFor, standardCategoriesOf } from './synonyms';

describe('categoriesFor', () => {
  it('maps the word that started all this', () => {
    // "i am looking for where to get food" returned nothing while thirty-four
    // restaurants sat in the database.
    expect(categoriesFor('food')).toEqual([CATEGORIES.restaurant]);
    expect(categoriesFor('i am looking for where to get food')).toEqual([
      CATEGORIES.restaurant,
    ]);
  });

  it('understands how people actually ask for a meal', () => {
    for (const phrase of [
      'somewhere to eat',
      'I want to chop',
      'any buka around?',
      'restaurants near me',
      'something to eat',
      'mama put',
    ]) {
      expect(categoriesFor(phrase)).toContain(CATEGORIES.restaurant);
    }
  });

  it('covers the other categories', () => {
    expect(categoriesFor('laptop')).toContain(CATEGORIES.gadgets);
    expect(categoriesFor('air conditioner')).toContain(
      CATEGORIES.homeAppliances,
    );
    expect(categoriesFor('I need a fridge')).toContain(
      CATEGORIES.homeAppliances,
    );
    expect(categoriesFor('power bank')).toContain(CATEGORIES.phoneAccessories);
  });

  it('returns both when a word genuinely belongs to both', () => {
    // "phone" could be the handset or the accessories. Guessing one and being
    // confidently wrong is worse than showing both.
    const both = categoriesFor('phone charger');
    expect(both).toContain(CATEGORIES.gadgets);
    expect(both).toContain(CATEGORIES.phoneAccessories);
  });

  it('knows a dish, or being hungry, is food — so suggestions stay food', () => {
    // Only used when the dish itself found nothing: then "jollof rice" is food, and the
    // suggestions are food vendors, never the shop next door.
    expect(categoriesFor('jollof rice')).toEqual([CATEGORIES.restaurant]);
    expect(categoriesFor("I'm hungry")).toEqual([CATEGORIES.restaurant]);
    expect(categoriesFor('ofada and dodo')).toEqual([CATEGORIES.restaurant]);
  });

  it('reads a phrase before its words — a rice cooker is not rice', () => {
    expect(categoriesFor('rice cooker')).toEqual([CATEGORIES.homeAppliances]);
  });

  it('reads plurals as their word — "wears", "caps", "dresses"', () => {
    expect(categoriesFor('wears')).toEqual([CATEGORIES.fashion]);
    expect(categoriesFor('any bags or caps?')).toEqual([CATEGORIES.fashion]);
    expect(categoriesFor('dresses')).toEqual([CATEGORIES.fashion]);
    // Not every word ending in s is a plural of one we know.
    expect(categoriesFor('glass')).toEqual([]);
  });

  it('knows fashion', () => {
    expect(categoriesFor('ankara gown')).toEqual([CATEGORIES.fashion]);
    expect(categoriesFor('sneakers')).toEqual([CATEGORIES.fashion]);
  });

  it('reads vendors’ own categories, however they typed them', () => {
    expect(standardCategoriesOf('Restaurant')).toEqual([CATEGORIES.restaurant]);
    expect(standardCategoriesOf('food')).toEqual([CATEGORIES.restaurant]);
    expect(standardCategoriesOf('Barbecue, food')).toEqual([
      CATEGORIES.restaurant,
    ]);
    expect(standardCategoriesOf('Iphones, androids, ipads, etc')).toEqual([
      CATEGORIES.gadgets,
    ]);
    expect(standardCategoriesOf(null)).toEqual([]);
  });

  it('says nothing when the words name no kind of thing', () => {
    expect(categoriesFor('Mama Ngozi')).toEqual([]);
    expect(categoriesFor('')).toEqual([]);
    expect(categoriesFor(undefined)).toEqual([]);
  });

  it('is not fooled by punctuation or case', () => {
    expect(categoriesFor('FOOD!')).toEqual([CATEGORIES.restaurant]);
    expect(categoriesFor('food, please')).toEqual([CATEGORIES.restaurant]);
  });

  it('does not match a word merely containing a synonym', () => {
    // "seafood" ends in "food" but a substring match would also catch "foodie",
    // "fanatic" for "fan", and "pcs" for "pc". Tokens, not substrings.
    expect(categoriesFor('seafood platter')).toEqual([]);
  });
});
