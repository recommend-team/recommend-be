import { CATEGORIES, categoriesFor } from './synonyms';

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

  it('says nothing when the buyer named a specific thing', () => {
    // These must fall through to ordinary text search, which is more precise. Widening
    // "jollof rice" to every restaurant would bury the dish they asked for.
    expect(categoriesFor('jollof rice')).toEqual([]);
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
