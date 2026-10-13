/**
 * The model is not allowed to state a price.
 *
 * Prices are rendered by the client from the structured payload, whose numbers come
 * straight out of the database. If model prose also contains an amount, it is either
 * redundant or wrong — and a wrong one is a quoted price the buyer will hold you to.
 *
 * So any amount in the text must match a figure a tool actually returned. Anything
 * else is treated as invented and the sentence carrying it is dropped.
 */

const AMOUNT_PATTERN =
  /(?:₦|NGN\s*|N(?=\d))\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:naira|NGN)/gi;

export interface PriceGuardResult {
  text: string;
  /** Amounts that appeared in the prose but in no tool result. */
  violations: number[];
}

/** Every amount mentioned in a piece of text, as numbers. */
export function extractAmounts(text: string): number[] {
  const amounts: number[] = [];

  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const raw = match[1] ?? match[2];
    if (!raw) continue;

    const value = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(value)) amounts.push(value);
  }

  return amounts;
}

/**
 * Strips any sentence quoting an amount that no tool returned.
 *
 * Deliberately conservative: it removes the offending sentence rather than the whole
 * reply, so a useful answer that happens to include one bad figure still reaches the
 * buyer minus the figure.
 */
export function enforcePriceIntegrity(
  text: string,
  allowedPrices: number[],
): PriceGuardResult {
  const allowed = new Set(allowedPrices.map((price) => round2(price)));
  const violations: number[] = [];

  // Keep the delimiter so rebuilt text reads naturally.
  const sentences = text.split(/(?<=[.!?])\s+/);

  const kept = sentences.filter((sentence) => {
    const amounts = extractAmounts(sentence);
    const invented = amounts.filter((amount) => !allowed.has(round2(amount)));

    if (invented.length > 0) {
      violations.push(...invented);
      return false;
    }
    return true;
  });

  return { text: kept.join(' ').trim(), violations };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
