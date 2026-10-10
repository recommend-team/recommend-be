import {
  RecommendFacts,
  answerFromKnowledge,
  buildKnowledge,
  describeAreas,
  naira,
} from './knowledge';

const area = (id: string, name: string, stateName = 'Lagos') => ({
  id,
  name,
  stateName,
});

const facts: RecommendFacts = {
  deliveryFee: 1500,
  servedAreas: [area('a1', 'Yaba'), area('a2', 'Ikeja')],
};

const textOf = (said: string) => {
  const answer = answerFromKnowledge(said, facts);
  return answer?.kind === 'text' ? answer.text : null;
};

describe('what the assistant knows', () => {
  describe('the prompt section', () => {
    const knowledge = buildKnowledge(facts);

    it('quotes the delivery fee from the system, not from memory', () => {
      expect(knowledge).toContain('flat ₦1,500');
      expect(buildKnowledge({ ...facts, deliveryFee: 2000 })).toContain(
        'flat ₦2,000',
      );
    });

    it('names the areas we actually cover', () => {
      expect(knowledge).toContain('Yaba (Lagos), Ikeja (Lagos)');
    });

    it('gives the agreed delivery time, and forbids promising an exact one', () => {
      expect(knowledge).toContain('usually 20 to 30 minutes');
      expect(knowledge).toContain('Never promise an exact time');
    });

    it('covers payment, pickup, the Orders tab, signing in and support', () => {
      expect(knowledge).toMatch(/Paystack — card, bank transfer or USSD/);
      expect(knowledge).toMatch(/Pickup: free/);
      expect(knowledge).toMatch(/Orders tab/);
      expect(knowledge).toMatch(/Signing in: optional/);
      expect(knowledge).toContain('+234 814 306 7676');
    });

    it('says nothing about refunds — the team decides those', () => {
      expect(knowledge).not.toMatch(/refund/i);
    });

    it('is honest when no area has a vendor yet', () => {
      expect(buildKnowledge({ ...facts, servedAreas: [] })).toContain(
        'Areas we cover right now: none yet',
      );
    });
  });

  describe('describing the areas', () => {
    it('summarises a long list rather than reciting it', () => {
      const many = Array.from({ length: 45 }, (_, i) =>
        area(`a${i}`, `Area ${i}`),
      );

      expect(describeAreas(many)).toMatch(/and 5 more$/);
    });
  });

  it('writes naira with thousands separators', () => {
    expect(naira(1500)).toBe('₦1,500');
  });

  describe('answering without a model', () => {
    it.each([
      'how much is delivery?',
      'what is the delivery fee',
      'Delivery cost?',
    ])('answers "%s" with the fee and the time', (said) => {
      const text = textOf(said);

      expect(text).toContain('₦1,500');
      expect(text).toContain('pickup is free');
      expect(text).toContain('20 to 30 minutes');
    });

    it('answers how long delivery takes', () => {
      expect(textOf('how long does delivery take')).toBe(
        'Delivery usually takes 20 to 30 minutes, a little longer at busy times or in the rain.',
      );
    });

    it('explains pickup', () => {
      expect(textOf('can I pick it up myself?')).toMatch(/collection code/);
    });

    it('explains payment', () => {
      expect(textOf('how do I pay')).toMatch(/card, bank transfer or USSD/);
      expect(textOf('can I pay with transfer')).toMatch(/Paystack/);
    });

    it('gives the support details', () => {
      expect(textOf('what is your phone number')).toContain(
        '+234 814 306 7676',
      );
    });

    it.each(['where is my order', "where's my food", 'track my order'])(
      'looks up the order for "%s"',
      (said) => {
        expect(answerFromKnowledge(said, facts)).toEqual({ kind: 'orders' });
      },
    );

    it.each([
      'which areas do you cover',
      'do you deliver to Yaba?',
      'where do you deliver',
    ])('checks coverage for "%s"', (said) => {
      expect(answerFromKnowledge(said, facts)).toEqual({ kind: 'coverage' });
    });

    it.each([
      'I want a refund',
      'can I cancel my order',
      'they brought the wrong order',
    ])('offers the team for "%s" rather than answering', (said) => {
      expect(answerFromKnowledge(said, facts)?.kind).toBe('team');
    });

    it.each([
      'jollof rice',
      'pizza in yaba',
      'I want shawarma',
      'phone charger',
    ])('leaves "%s" to the product search', (said) => {
      expect(answerFromKnowledge(said, facts)).toBeNull();
    });
  });
});
