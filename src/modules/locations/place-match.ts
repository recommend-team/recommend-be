/**
 * Reading where a buyer is from how they say it.
 *
 * Buyers don't use our area names. Someone in Ajah says "Badore", "Ajah miles" or
 * "Akinwale Road, Ajah"; someone in Lekki says "Chevron", "Lekki Phase 1" or "Leki".
 * These are the pure parts of matching that to an area: one way of writing a place, and
 * how close two spellings are.
 */

/** "Abraham-Adesanya, Ajah!" → "abraham adesanya ajah". */
export function normalisePlace(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Whether `phrase` appears in `text` as whole words: "vi" in "ahmadu bello vi", not in "vine". */
export function containsPlace(text: string, phrase: string): boolean {
  if (!phrase) return false;
  return ` ${text} `.includes(` ${phrase} `);
}

/**
 * Edits between two spellings, a swap of neighbours counting as one — "ajha" is one
 * step from "ajah", "leki" one from "lekki".
 */
export function spellingDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * Close enough to be the same place misspelt — one slip in a short name, two in a long
 * one. Names under four letters are never guessed at: "ojo" and "oyo" are different.
 */
export function looksLike(said: string, name: string): boolean {
  if (said === name) return false;
  if (said.length < 4 || name.length < 4) return false;
  const allowed = name.length >= 8 ? 2 : 1;
  return spellingDistance(said, name) <= allowed;
}

/** The words of what was said, and each pair of neighbouring words, to try as names. */
export function placeCandidates(text: string): string[] {
  const words = normalisePlace(text).split(' ').filter(Boolean);
  const pairs = words.slice(1).map((word, i) => `${words[i]} ${word}`);
  return [...pairs, ...words];
}
