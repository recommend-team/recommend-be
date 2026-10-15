import { stripCardEcho } from './card-echo';

describe('taking out the list the cards already show', () => {
  it('drops a numbered list, keeping the sentence before it', () => {
    // Word for word what the model sent alongside four cards.
    const reply = [
      "I couldn't find exactly what you asked for, but here are some close options available in Egbeda:",
      '',
      '1. Jolof Rice from Chinwe Delicacies',
      '2. Beans and Fried Plantain from Iya Basira Buka',
      '3. Fried Rice and Turkey from Iya Basira Buka',
      '4. Jollof Rice with Chicken from Mama Ngozi Kitchen',
      '',
      'Please let me know if any of these sound good to you!',
    ].join('\n');

    expect(stripCardEcho(reply)).toBe(
      "I couldn't find exactly what you asked for, but here are some close options available in Egbeda:\n\n" +
        'Please let me know if any of these sound good to you!',
    );
  });

  it('drops a list run into one line, and the bold', () => {
    const reply =
      'I found a few laptops available in Lekki. Here are some options:\n\n' +
      '1. **MacBook Air M1 — 8GB/256GB** from Admiralty Gadgets. 2. **Asus VivoBook 14 — Core i3** from Admiralty Gadgets.';

    expect(stripCardEcho(reply)).toBe(
      'I found a few laptops available in Lekki. Here are some options:',
    );
  });

  it('drops a list inside a sentence', () => {
    expect(
      stripCardEcho(
        'Here is what is near you: 1. **Suya Platter** from Mama Ngozi. 2. **Nkwobi** from Mama Ngozi.',
      ),
    ).toBe('Here is what is near you:');
  });

  it('drops bulleted lists', () => {
    expect(stripCardEcho('Here you go:\n- Jollof Rice\n* Suya\n• Nkwobi')).toBe(
      'Here you go:',
    );
  });

  it('leaves an ordinary reply alone', () => {
    const reply =
      "Here's what I found near you in Ikeja — tap one to see the menu.";
    expect(stripCardEcho(reply)).toBe(reply);
  });

  it('leaves a sentence that merely mentions numbers alone', () => {
    const reply =
      'Delivery takes 20 to 30 minutes, and the fee is shown at checkout.';
    expect(stripCardEcho(reply)).toBe(reply);
  });

  it('can leave nothing, for the caller to fill in', () => {
    expect(stripCardEcho('1. Jollof\n2. Suya')).toBe('');
  });
});
