import { asksWhyDetails, isAside, onlySaysNotHeard } from './aside';

describe('telling a question from an answer, mid-checkout', () => {
  // The conversation this exists for, word for word.
  it.each([
    'what do you need thesed etails for?, my phone, email and address too',
    'i asked a question',
    'you have not answered my question . what do you need these details for?, my phone, email and address too',
  ])('the screenshot: "%s" is not an answer', (said) => {
    expect(isAside(said)).toBe(true);
  });

  it.each([
    'how long will delivery take?',
    'why do you need my phone number',
    'can you deliver it before 2pm',
    'is this safe',
    'are you even reading my messages',
    'what is this for',
  ])('"%s" is a question', (said) => {
    expect(isAside(said)).toBe(true);
  });

  it.each([
    'Ada Obi',
    'Will Okafor',
    'Who Okeke',
    '08012345678',
    '08012345678?',
    '12 Allen Avenue, Ikeja',
    '12 Allen Avenue, Ikeja?',
    'Plot 5, Admiralty Way, Lekki',
    'ada@example.com',
    'Yes, same address',
    'Yaba',
    'opposite the big mosque',
    'Skip',
    'deliver',
  ])('"%s" is an answer', (said) => {
    expect(isAside(said)).toBe(false);
  });

  describe('"i asked a question"', () => {
    it.each([
      'i asked a question',
      'I asked you a question!',
      'are you even reading',
    ])('"%s" points back at an earlier question', (said) => {
      expect(onlySaysNotHeard(said)).toBe(true);
    });

    it('carries its own question when it has one — the screenshot', () => {
      expect(
        onlySaysNotHeard(
          'you have not answered my question . what do you need these details for?, my phone, email and address too',
        ),
      ).toBe(false);
    });
  });

  describe('"why do you need my details?"', () => {
    it.each([
      'what do you need thesed etails for?, my phone, email and address too',
      'why do you need my phone number',
      'what will you use my address for?',
      'why do you want my email',
    ])('recognises "%s"', (said) => {
      expect(asksWhyDetails(said)).toBe(true);
    });

    it.each(['how long will delivery take?', 'what is the delivery fee?'])(
      'leaves "%s" to the general answers',
      (said) => {
        expect(asksWhyDetails(said)).toBe(false);
      },
    );
  });
});
