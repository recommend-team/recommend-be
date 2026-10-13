/**
 * Neutralise attacker-controlled text before it reaches the model.
 */

/** Zero-width and bidi control characters, used to hide text from human reviewers. */
const INVISIBLE = new RegExp(
  '[' +
    '\\u200B-\\u200F' +
    '\\u202A-\\u202E' +
    '\\u2060-\\u2064' +
    '\\uFEFF' +
    ']',
  'g',
);

/** C0/C1 control characters, except tab and newline. */
const CONTROL = new RegExp(
  '[' + '\\u0000-\\u0008' + '\\u000B-\\u001F' + '\\u007F-\\u009F' + ']',
  'g',
);

/**
 * Phrases whose only purpose in a product name is to address the model. Matched
 * case-insensitively and replaced rather than deleted, so the text stays readable and
 * a human reviewing logs can see what was attempted.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|messages?)/gi,
  /\b(?:system|assistant|developer|user)\s*(?::|>>)/gi,
  /<\s*\/?\s*(?:system|assistant|user|instructions?)\s*>/gi,
  /\bnew\s+instructions?\s*:/gi,
  /\byou\s+are\s+now\b/gi,
  /\boverride\b.{0,20}\b(?:price|instruction|rule)/gi,
  /```/g,
];

const REDACTED = '[removed]';

/**
 * Clean a single field of vendor-authored text.
 *
 * `maxLength` exists because a very long description is itself an attack: it pushes the
 * system prompt out of the model's attention and burns tokens on every turn.
 */
export function sanitizeUntrusted(
  value: string | null | undefined,
  maxLength = 200,
): string {
  if (!value) return '';

  let clean = value.replace(INVISIBLE, '').replace(CONTROL, ' ');

  for (const pattern of INJECTION_PATTERNS) {
    clean = clean.replace(pattern, REDACTED);
  }

  // Collapse whitespace so newline-padded payloads cannot fake message boundaries.
  clean = clean.replace(/\s+/g, ' ').trim();

  return clean.length > maxLength
    ? `${clean.slice(0, maxLength).trimEnd()}…`
    : clean;
}

/** True when sanitising actually removed something — worth logging. */
export function wasSanitised(original: string | null | undefined): boolean {
  if (!original) return false;
  return (
    sanitizeUntrusted(original, Number.MAX_SAFE_INTEGER) !== original.trim()
  );
}
