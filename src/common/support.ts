/**
 * How buyers reach the team — said by the assistant, printed in order emails, and shown on
 * the website's order page. Same details as the customer app's Help & contact and the
 * website's contact page (each reads its own variable, with these same defaults).
 *
 * `SUPPORT_PHONE` and `SUPPORT_EMAIL` override the defaults. Read on each call rather than
 * once at import: locally, `.env` is loaded after this file is first imported.
 */
export const DEFAULT_SUPPORT_PHONE = '+234 814 306 7676';
export const DEFAULT_SUPPORT_EMAIL = 'contacts.recommend@gmail.com';

export const SUPPORT_HOURS =
  'Monday to Friday 8am to 9pm, and Saturday 9am to 8pm';

/** The number buyers call, written for people: `+234 814 306 7676`. */
export function supportPhone(): string {
  return process.env.SUPPORT_PHONE?.trim() || DEFAULT_SUPPORT_PHONE;
}

/** The same number for a `tel:` link — no spaces. */
export function supportPhoneHref(): string {
  return `tel:${supportPhone().replace(/[^\d+]/g, '')}`;
}

export function supportEmail(): string {
  return process.env.SUPPORT_EMAIL?.trim() || DEFAULT_SUPPORT_EMAIL;
}
