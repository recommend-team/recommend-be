/**
 * Buyers type phone numbers the way they say them — "0801 234 5678", "234801…",
 * "+234 801-234-5678". `createCheckoutSchema` requires strict E.164, and the WhatsApp
 * identity will arrive as E.164 too, so everything is normalised on the way in.
 *
 * Getting this wrong silently orphans a buyer's order history, because orders are
 * matched to buyers by phone string.
 */

const NIGERIA_CC = '234';

/** Returns E.164 (e.g. +2348012345678), or null if it cannot be made sense of. */
export function toE164(
  raw: string,
  defaultCountryCode = NIGERIA_CC,
): string | null {
  if (!raw) return null;

  const trimmed = raw.trim();
  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  if (!digits) return null;

  // Already international.
  if (hadPlus) return isPlausible(digits) ? `+${digits}` : null;

  // 2348012345678
  if (digits.startsWith(defaultCountryCode)) {
    return isPlausible(digits) ? `+${digits}` : null;
  }

  // 08012345678 — national trunk prefix
  if (digits.startsWith('0')) {
    const candidate = `${defaultCountryCode}${digits.slice(1)}`;
    return isPlausible(candidate) ? `+${candidate}` : null;
  }

  // 8012345678 — bare national number
  const candidate = `${defaultCountryCode}${digits}`;
  return isPlausible(candidate) ? `+${candidate}` : null;
}

/** Mirrors the E.164 rule enforced by createCheckoutSchema. */
function isPlausible(digits: string): boolean {
  return /^[1-9]\d{7,14}$/.test(digits);
}

/** "+2348012345678" → "+234 801 234 5678", for reading back to the buyer. */
export function formatForDisplay(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (!digits.startsWith(NIGERIA_CC) || digits.length !== 13) return e164;
  const national = digits.slice(3);
  return `+${NIGERIA_CC} ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
}

/** ₦12,000 — used when reading an order back before the buyer pays for it. */
export function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}
