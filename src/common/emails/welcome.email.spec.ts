import { buildWelcomeEmail, type WelcomeLinks } from './welcome.email';

const links: WelcomeLinks = {
  websiteUrl: 'https://recommend-fe.netlify.app',
  customerAppUrl: 'https://order.example',
  vendorAppUrl: 'https://vendors.example',
};

describe('buildWelcomeEmail', () => {
  it('greets a customer by first name, from the founder', () => {
    const email = buildWelcomeEmail('customer', 'Ada Obi', links);

    expect(email.subject).toBe('Welcome to Recommend, Ada — a note from me');
    expect(email.text).toContain('Hi Ada,');
    expect(email.text).toContain("I'm Chanor James, the founder of Recommend");
    expect(email.text).toContain('Chanor James\nFounder, Recommend');
  });

  it('still reads well without a name', () => {
    const email = buildWelcomeEmail('customer', null, links);

    expect(email.subject).toBe('Welcome to Recommend — a note from me');
    expect(email.text.startsWith('Hi there,')).toBe(true);
  });

  it('shows the PNG logo from the website — email clients do not show SVG', () => {
    const { html } = buildWelcomeEmail('customer', 'Ada', links);

    expect(html).toContain(
      'src="https://recommend-fe.netlify.app/email/recommend-logo.png"',
    );
    expect(html).toContain('alt="Recommend"');
  });

  it.each([
    ['customer', 'Find food near me', 'https://order.example'],
    ['vendor', 'Open your dashboard', 'https://vendors.example'],
    ['rider', 'Contact us', 'https://recommend-fe.netlify.app/contact'],
  ] as const)(
    'gives a %s the button for their next step',
    (audience, label, href) => {
      const { html, text } = buildWelcomeEmail(audience, 'Ada', links);

      expect(html).toContain(`href="${href}"`);
      expect(html).toContain(label);
      expect(text).toContain(`${label}: ${href}`);
    },
  );

  it('tells vendors their account is reviewed before they go live', () => {
    const { text } = buildWelcomeEmail('vendor', 'Ada', links);

    expect(text).toContain('reviews every new vendor before they go live');
    expect(text).toContain('Add your products');
  });

  it('never lets a name become markup', () => {
    const { html } = buildWelcomeEmail(
      'customer',
      '<script>alert(1)</script>',
      links,
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
