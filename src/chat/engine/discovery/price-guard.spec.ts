import { enforcePriceIntegrity, extractAmounts } from './price-guard';

describe('price guard', () => {
  describe('extractAmounts', () => {
    it.each([
      ['₦3,000', 3000],
      ['₦3000', 3000],
      ['NGN 4,500', 4500],
      ['N2500', 2500],
      ['1,200 naira', 1200],
      ['₦1,499.99', 1499.99],
    ])('reads %s as %d', (text, expected) => {
      expect(extractAmounts(text)).toEqual([expected]);
    });

    it('finds several amounts in one sentence', () => {
      expect(extractAmounts('₦3,000 and ₦4,500')).toEqual([3000, 4500]);
    });

    it('ignores bare numbers that are not money', () => {
      expect(extractAmounts('I found 3 restaurants with 2 options')).toEqual(
        [],
      );
    });
  });

  describe('enforcePriceIntegrity', () => {
    it('keeps a price that a tool actually returned', () => {
      const result = enforcePriceIntegrity('Jollof is ₦3,000 here.', [3000]);

      expect(result.text).toBe('Jollof is ₦3,000 here.');
      expect(result.violations).toEqual([]);
    });

    it('drops a price no tool returned', () => {
      const result = enforcePriceIntegrity('Jollof is ₦1,500 here.', [3000]);

      expect(result.text).toBe('');
      expect(result.violations).toEqual([1500]);
    });

    it('removes only the offending sentence, keeping the useful answer', () => {
      const result = enforcePriceIntegrity(
        'I found two places near you. Jollof is ₦900 there. Tap one to see the menu.',
        [3000],
      );

      expect(result.text).toBe(
        'I found two places near you. Tap one to see the menu.',
      );
      expect(result.violations).toEqual([900]);
    });

    it('leaves prose with no amounts untouched', () => {
      const text = "Here's what I found near you.";
      expect(enforcePriceIntegrity(text, []).text).toBe(text);
    });

    it('treats every amount as invented when no tool returned prices', () => {
      const result = enforcePriceIntegrity('That costs ₦2,000.', []);

      expect(result.violations).toEqual([2000]);
      expect(result.text).toBe('');
    });

    it('matches on value, not formatting', () => {
      const result = enforcePriceIntegrity('It is NGN 3000.', [3000]);
      expect(result.violations).toEqual([]);
    });

    it('tolerates rounding noise from decimal columns', () => {
      const result = enforcePriceIntegrity('It is ₦1,499.99.', [1499.99]);
      expect(result.violations).toEqual([]);
    });

    it('catches a plausible-looking but wrong total', () => {
      // The classic failure: the model adds two real prices and states the sum.
      const result = enforcePriceIntegrity(
        'Two jollof and one pounded yam comes to ₦10,500.',
        [3000, 4500],
      );

      expect(result.violations).toEqual([10500]);
      expect(result.text).toBe('');
    });
  });
});
