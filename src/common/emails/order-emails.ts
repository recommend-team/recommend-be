/**
 * The two emails a buyer gets about an order: a receipt when it is paid, and "on its
 * way" — with the delivery code — when a rider leaves with it.
 *
 * For a buyer who ordered from a vendor's storefront and never opens the chat, these are
 * the whole follow-up: the code the rider will ask for, the rider's number, and ours. Each
 * also invites them into the chat, where their order is already waiting.
 *
 * Table-based HTML with inline styles, like the welcome email: what email clients render.
 */
import { SUPPORT_PHONE } from '../support';

export interface OrderEmailLinks {
  /** The public website — serves the logo. */
  websiteUrl: string;
  customerAppUrl: string;
}

export interface OrderEmail {
  subject: string;
  html: string;
  text: string;
}

export interface ReceiptDetails {
  buyerName: string;
  buyerEmail: string;
  reference: string;
  fulfillmentType: string;
  deliveryAddress: string | null;
  goodsTotal: number;
  deliveryFee: number;
  totalAmount: number;
  vendors: {
    vendorName: string | null;
    items: { name: string; quantity: number; lineTotal: number }[];
  }[];
}

export interface OnItsWayDetails {
  buyerName: string;
  buyerEmail: string;
  reference: string;
  deliveryCode: string;
  vendorNames: string[];
  rider: { name: string; phone: string | null } | null;
}

const BRAND = {
  orange: '#EC5B2C',
  green: '#006837',
  ink: '#1F2937',
  muted: '#6B7280',
  cream: '#FAF6E1',
  hairline: '#ECE7D2',
};

/** The customer app, opened on sign-in with this email filled in. */
export function followLink(links: OrderEmailLinks, email: string): string {
  return `${links.customerAppUrl}/?signin=${encodeURIComponent(email)}`;
}

export function buildReceiptEmail(
  order: ReceiptDetails,
  links: OrderEmailLinks,
): OrderEmail {
  const name = firstName(order.buyerName);
  const from = vendorList(order.vendors.map((v) => v.vendorName));
  const delivery = order.fulfillmentType !== 'PICKUP';
  const nextStep = delivery
    ? 'Your delivery code will be emailed to you when your order is on its way. Read it to the rider when they arrive.'
    : "We'll let you know when it's ready to collect.";

  const lines = order.vendors.flatMap((vendor) =>
    vendor.items.map((item) => ({
      label: `${item.quantity} × ${item.name}`,
      detail: order.vendors.length > 1 ? (vendor.vendorName ?? '') : '',
      amount: item.lineTotal,
    })),
  );

  const rows = [
    ...lines.map((line) => row(line.label, naira(line.amount), line.detail)),
    ...(order.deliveryFee > 0
      ? [row('Delivery', naira(order.deliveryFee))]
      : []),
    row('Total paid', naira(order.totalAmount), '', true),
  ].join('');

  const html = layout(links, {
    preheader: `Order ${order.reference} is paid — ${nextStep}`,
    body: `
      ${p(`Hi ${name},`)}
      ${p(`Thank you — your order from ${from} is paid.`)}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;border-top:1px solid ${BRAND.hairline};">${rows}
      </table>
      ${small(`Order ${order.reference}`)}
      ${delivery && order.deliveryAddress ? small(`Delivering to ${order.deliveryAddress}`) : ''}
      ${note(nextStep)}`,
    button: {
      label: 'Follow your order on Recommend',
      href: followLink(links, order.buyerEmail),
    },
  });

  const text = [
    `Hi ${name},`,
    '',
    `Thank you — your order from ${from} is paid.`,
    '',
    ...lines.map(
      (line) =>
        `${line.label}${line.detail ? ` (${line.detail})` : ''} — ${naira(line.amount)}`,
    ),
    ...(order.deliveryFee > 0
      ? [`Delivery — ${naira(order.deliveryFee)}`]
      : []),
    `Total paid — ${naira(order.totalAmount)}`,
    '',
    `Order ${order.reference}`,
    ...(delivery && order.deliveryAddress
      ? [`Delivering to ${order.deliveryAddress}`]
      : []),
    '',
    nextStep,
    '',
    `Follow your order on Recommend: ${followLink(links, order.buyerEmail)}`,
    ...textFooter(),
  ].join('\n');

  return {
    subject: `Your order from ${from} is paid — ${order.reference}`,
    html,
    text,
  };
}

export function buildOnItsWayEmail(
  order: OnItsWayDetails,
  links: OrderEmailLinks,
): OrderEmail {
  const name = firstName(order.buyerName);
  const from = vendorList(order.vendorNames);
  const code = order.deliveryCode;

  const rider = order.rider
    ? p(
        `Your rider is ${escape(order.rider.name)}${
          order.rider.phone
            ? ` — <a href="tel:${escape(order.rider.phone.replace(/\s/g, ''))}" style="color:${BRAND.green};font-weight:bold;">${escape(order.rider.phone)}</a>`
            : ''
        }.`,
        true,
      )
    : '';

  const html = layout(links, {
    preheader: `Your delivery code is ${code}. Read it to the rider when they arrive.`,
    body: `
      ${p(`Hi ${name},`)}
      ${p(`Your order from ${from} is on its way.`)}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;">
        <tr>
          <td align="center" style="padding:20px 16px;background:${BRAND.cream};border-radius:14px;">
            <p style="margin:0 0 6px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${BRAND.muted};font-weight:bold;">Your delivery code</p>
            <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:34px;letter-spacing:8px;font-weight:bold;color:${BRAND.green};">${escape(code)}</p>
            <p style="margin:8px 0 0;font-size:14px;line-height:1.5;color:${BRAND.ink};">Read it to the rider when they arrive. Only give it once you have your order.</p>
          </td>
        </tr>
      </table>
      ${rider}
      ${small(`Order ${order.reference}`)}`,
    button: {
      label: 'Follow your order on Recommend',
      href: followLink(links, order.buyerEmail),
    },
  });

  const text = [
    `Hi ${name},`,
    '',
    `Your order from ${from} is on its way.`,
    '',
    `YOUR DELIVERY CODE: ${code}`,
    'Read it to the rider when they arrive. Only give it once you have your order.',
    ...(order.rider
      ? [
          '',
          `Your rider is ${order.rider.name}${order.rider.phone ? ` — ${order.rider.phone}` : ''}.`,
        ]
      : []),
    '',
    `Order ${order.reference}`,
    '',
    `Follow your order on Recommend: ${followLink(links, order.buyerEmail)}`,
    ...textFooter(),
  ].join('\n');

  return {
    subject: `On its way — your delivery code is ${code}`,
    html,
    text,
  };
}

// ─── Shared pieces ───────────────────────────────────────────────────────────────

function layout(
  links: OrderEmailLinks,
  content: {
    preheader: string;
    body: string;
    button: { label: string; href: string };
  },
): string {
  const site = links.websiteUrl.replace(/^https?:\/\//, '');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>Recommend</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.cream};font-family:Helvetica,Arial,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escape(content.preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.cream};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden;">
            <tr><td style="height:6px;background:${BRAND.orange};font-size:0;line-height:0;">&nbsp;</td></tr>
            <tr>
              <td style="padding:28px 40px 4px;">
                <a href="${links.websiteUrl}"><img src="${links.websiteUrl}/email/recommend-logo.png" width="160" height="36" alt="Recommend" style="display:block;border:0;width:160px;height:auto;" /></a>
              </td>
            </tr>
            <tr><td style="padding:20px 40px 0;">${content.body}</td></tr>
            <tr>
              <td style="padding:8px 40px 28px;">
                <a href="${content.button.href}" style="display:inline-block;padding:14px 26px;background:${BRAND.orange};border-radius:12px;color:#FFFFFF;font-size:16px;font-weight:bold;text-decoration:none;">${escape(content.button.label)}</a>
                <p style="margin:12px 0 0;font-size:13px;line-height:1.5;color:${BRAND.muted};">Sign in with this email address — your order is already there, with every update.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 40px;border-top:3px solid ${BRAND.green};">
                <p style="margin:0 0 4px;font-size:14px;line-height:1.5;color:${BRAND.ink};">Questions about your order? Call us on <a href="tel:${SUPPORT_PHONE.replace(/\s/g, '')}" style="color:${BRAND.green};font-weight:bold;text-decoration:none;white-space:nowrap;">${SUPPORT_PHONE}</a></p>
                <p style="margin:0;font-size:12px;line-height:1.5;color:${BRAND.muted};">Recommend &middot; Lagos, Nigeria &middot; <a href="${links.websiteUrl}" style="color:${BRAND.muted};">${escape(site)}</a></p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function textFooter(): string[] {
  return [
    '',
    `Questions about your order? Call us on ${SUPPORT_PHONE}.`,
    '— Recommend',
  ];
}

/** A paragraph. `raw` when the text is already safe HTML (a link built here). */
function p(text: string, raw = false): string {
  return `<p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:${BRAND.ink};">${raw ? text : escape(text)}</p>`;
}

function small(text: string): string {
  return `<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:${BRAND.muted};">${escape(text)}</p>`;
}

function note(text: string): string {
  return `<p style="margin:14px 0 16px;padding:12px 16px;background:${BRAND.cream};border-radius:10px;font-size:14px;line-height:1.5;color:${BRAND.ink};">${escape(text)}</p>`;
}

function row(
  label: string,
  amount: string,
  detail = '',
  strong = false,
): string {
  const weight = strong ? 'bold' : 'normal';
  const size = strong ? '16px' : '15px';
  return `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid ${BRAND.hairline};font-size:${size};font-weight:${weight};color:${BRAND.ink};">${escape(label)}${
            detail
              ? `<br /><span style="font-size:12px;font-weight:normal;color:${BRAND.muted};">${escape(detail)}</span>`
              : ''
          }</td>
          <td align="right" style="padding:10px 0;border-bottom:1px solid ${BRAND.hairline};font-size:${size};font-weight:${weight};color:${BRAND.ink};white-space:nowrap;">${amount}</td>
        </tr>`;
}

function naira(amount: number): string {
  return `₦${Number(amount).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] || 'there';
}

/** "Mama Ngozi Kitchen", "A and B", "A, B and C". */
function vendorList(names: (string | null)[]): string {
  const known = [...new Set(names.filter((n): n is string => !!n))];
  if (known.length === 0) return 'Recommend';
  if (known.length === 1) return known[0];
  return `${known.slice(0, -1).join(', ')} and ${known[known.length - 1]}`;
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
