/**
 * The welcome email: a personal note from the founder, sent once, at a new user's first
 * verification — a vendor's or rider's sign-up code, a buyer's first verified email.
 *
 * Built by hand as table-based HTML with inline styles, because that is what email
 * clients render reliably: no stylesheet, no SVG, no web fonts they would drop anyway.
 */

export type WelcomeAudience = 'customer' | 'vendor' | 'rider';

export interface WelcomeLinks {
  /** The public website — also serves the logo. */
  websiteUrl: string;
  customerAppUrl: string;
  vendorAppUrl: string;
}

export interface WelcomeEmail {
  subject: string;
  html: string;
  text: string;
}

const BRAND = {
  orange: '#EC5B2C',
  green: '#006837',
  ink: '#1F2937',
  muted: '#6B7280',
  cream: '#FAF6E1',
  hairline: '#ECE7D2',
};

const SOCIALS = [
  { label: 'Instagram', href: 'https://www.instagram.com/chatrecommend' },
  { label: 'X', href: 'https://x.com/heyrecommend' },
  { label: 'TikTok', href: 'https://www.tiktok.com/@userecommend01' },
  { label: 'LinkedIn', href: 'https://www.linkedin.com/company/userecommend/' },
];

interface Copy {
  /** Shown beside the subject in most inboxes. */
  preheader: string;
  why: string;
  listIntro: string;
  points: string[];
  button: { label: string; href: string };
  /** Anything this reader must know before they start — a review, for instance. */
  note?: string;
  favour: string;
}

function copyFor(audience: WelcomeAudience, links: WelcomeLinks): Copy {
  switch (audience) {
    case 'vendor':
      return {
        preheader: 'Thank you for bringing your business to Recommend.',
        why:
          'We started Recommend to bring more customers to the kitchens and shops people ' +
          'already love. Buyers ask us, in a simple chat, for what they want near them — ' +
          'and we send them to vendors like you.',
        listIntro: 'Here’s how to get ready for your first orders:',
        points: [
          'Add your products, with clear photos and prices',
          'Set your opening hours and the areas you serve',
          'Add a payout account, so your earnings reach you',
        ],
        button: { label: 'Open your dashboard', href: links.vendorAppUrl },
        note:
          'Our team reviews every new vendor before they go live. We’ll let you know as ' +
          'soon as you’re approved.',
        favour:
          'One small favour: reply to this email and tell me what would make Recommend ' +
          'most useful for your business. I read every reply, and your feedback shapes ' +
          'what we build next.',
      };
    case 'rider':
      return {
        preheader: 'Thank you for riding with Recommend.',
        why:
          'Riders are how a great meal actually reaches someone’s door. We started ' +
          'Recommend to make ordering in Lagos simple and reliable, and that only works ' +
          'with riders people can trust.',
        listIntro: 'Here’s what happens next:',
        points: [
          'Our team reviews your details',
          'We’ll be in touch to get you set up and on the road',
          'Then you’ll start receiving deliveries near you',
        ],
        button: { label: 'Contact us', href: `${links.websiteUrl}/contact` },
        favour:
          'One small favour: reply to this email and tell me what would make delivering ' +
          'with Recommend work best for you. I read every reply.',
      };
    default:
      return {
        preheader: 'A personal thank-you from our founder.',
        why:
          'We started Recommend because finding a good meal in Lagos shouldn’t be ' +
          'stressful. Too often it means scrolling, guessing, and hoping your food arrives ' +
          'hot. We’re building a better way to discover great food around you and order ' +
          'it with confidence.',
        listIntro: 'Here’s what you can do right now:',
        points: [
          'Discover restaurants and food vendors near you',
          'Order by simply chatting with us — no forms, no fuss',
          'Follow your order from the kitchen to your door',
        ],
        button: { label: 'Find food near me', href: links.customerAppUrl },
        favour:
          'One small favour: reply to this email and tell me what you’d most love to see ' +
          'on Recommend. I read every reply, and your feedback shapes what we build next.',
      };
  }
}

export function buildWelcomeEmail(
  audience: WelcomeAudience,
  firstName: string | null | undefined,
  links: WelcomeLinks,
): WelcomeEmail {
  const name = firstName?.trim().split(/\s+/)[0] || null;
  const copy = copyFor(audience, links);
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const subject = name
    ? `Welcome to Recommend, ${name} — a note from me`
    : 'Welcome to Recommend — a note from me';

  return {
    subject,
    html: renderHtml(copy, greeting, links),
    text: renderText(copy, greeting),
  };
}

// ─── HTML ────────────────────────────────────────────────────────────────────────

function renderHtml(copy: Copy, greeting: string, links: WelcomeLinks): string {
  const p = (text: string) =>
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:${BRAND.ink};">${escape(text)}</p>`;

  const points = copy.points
    .map(
      (point) => `
              <tr>
                <td valign="top" style="padding:0 10px 10px 0;font-size:16px;line-height:1.5;color:${BRAND.orange};font-weight:bold;">&#8226;</td>
                <td style="padding:0 0 10px;font-size:16px;line-height:1.5;color:${BRAND.ink};">${escape(point)}</td>
              </tr>`,
    )
    .join('');

  const note = copy.note
    ? `
          <tr>
            <td style="padding:0 40px 8px;">
              <p style="margin:0 0 16px;padding:12px 16px;background:${BRAND.cream};border-radius:10px;font-size:14px;line-height:1.5;color:${BRAND.ink};">${escape(copy.note)}</p>
            </td>
          </tr>`
    : '';

  const socials = SOCIALS.map(
    (social) =>
      `<a href="${social.href}" style="color:${BRAND.green};text-decoration:none;font-weight:bold;">${social.label}</a>`,
  ).join(' &nbsp;&middot;&nbsp; ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>Welcome to Recommend</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.cream};font-family:Helvetica,Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escape(copy.preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.cream};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="height:6px;background:${BRAND.orange};font-size:0;line-height:0;">&nbsp;</td>
            </tr>
            <tr>
              <td style="padding:32px 40px 8px;">
                <a href="${links.websiteUrl}">
                  <img src="${links.websiteUrl}/email/recommend-logo.png" width="160" height="36" alt="Recommend" style="display:block;border:0;width:160px;height:auto;" />
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 40px 0;">
                ${p(greeting)}
                ${p('I’m Chanor James, the founder of Recommend, and I wanted to personally say thank you for joining us.')}
                ${p(copy.why)}
                ${p(copy.listIntro)}
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">${points}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 40px 24px;">
                <a href="${copy.button.href}" style="display:inline-block;padding:14px 28px;background:${BRAND.orange};border-radius:12px;color:#FFFFFF;font-size:16px;font-weight:bold;text-decoration:none;">${escape(copy.button.label)}</a>
              </td>
            </tr>${note}
            <tr>
              <td style="padding:0 40px 8px;">
                ${p(copy.favour)}
                ${p('Thank you for being here at the start.')}
                <p style="margin:24px 0 0;font-size:16px;line-height:1.4;color:${BRAND.ink};font-weight:bold;">Chanor James</p>
                <p style="margin:2px 0 32px;font-size:14px;line-height:1.4;color:${BRAND.muted};">Founder, Recommend</p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 40px;border-top:3px solid ${BRAND.green};background:#FFFFFF;">
                <p style="margin:0 0 6px;font-size:13px;line-height:1.5;">${socials}</p>
                <p style="margin:0;font-size:12px;line-height:1.5;color:${BRAND.muted};">Recommend &middot; Lagos, Nigeria &middot; <a href="${links.websiteUrl}" style="color:${BRAND.muted};">${escape(links.websiteUrl.replace(/^https?:\/\//, ''))}</a></p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// ─── Plain text, for clients that will not show HTML ─────────────────────────────

function renderText(copy: Copy, greeting: string): string {
  return [
    greeting,
    '',
    "I'm Chanor James, the founder of Recommend, and I wanted to personally say thank you for joining us.",
    '',
    copy.why,
    '',
    copy.listIntro,
    ...copy.points.map((point) => `- ${point}`),
    '',
    `${copy.button.label}: ${copy.button.href}`,
    ...(copy.note ? ['', copy.note] : []),
    '',
    copy.favour,
    '',
    'Thank you for being here at the start.',
    '',
    'Chanor James',
    'Founder, Recommend',
  ].join('\n');
}

/** A name is the reader's own words — never let it become markup. */
function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
