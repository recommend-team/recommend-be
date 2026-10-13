/**
 * Messages sent during checkout that are not answers — a question, or the buyer saying
 * they were not heard. Read as answers, "why do you need my address?" became the address
 * and "i asked a question" an area; caught in a real conversation.
 *
 * Deliberately conservative: an answer mistaken for a question costs the buyer one
 * repeat of the question, while a question mistaken for an answer puts it on the order.
 * Even so, digits mean an answer — "08012345678?" is a phone number, "12 Allen Avenue?"
 * an address — and a bare "Will Okafor" is a name, not the start of a question.
 */

const QUESTION_WORD = /^(what|why|how|where|when|who|which|whats|what's)\b/i;
const AUXILIARY =
  /^(can|could|do|does|did|is|are|will|would|should|may)\s+(you|i|we|it|this|that|there|they|my|your)\b/i;
const NOT_HEARD =
  /\b(i asked( you)?( a)? question|answer (my|the) question|you (have not|haven't|didn't|did not|never) answer(ed)?|are you (even )?(reading|listening)|you('re| are) not (reading|listening))\b/i;

export function isAside(text: string): boolean {
  const said = text.trim();
  if (!said) return false;
  if (NOT_HEARD.test(said)) return true;

  // Phrased as a question from the first word: "can you deliver it before 2pm".
  const words = said.split(/\s+/).length;
  if (words >= 3 && (QUESTION_WORD.test(said) || AUXILIARY.test(said))) {
    return true;
  }
  // A question mark alone is not enough when there are digits — that is an answer the
  // buyer is unsure of: "08012345678?", "12 Allen Avenue, Ikeja?".
  return said.endsWith('?') && !/\d/.test(said);
}

/**
 * "i asked a question", and nothing else — the buyer pointing back at an earlier
 * question, which is the one to answer. "you have not answered my question. what do
 * you need these details for?" carries its own question, so is not this.
 */
export function onlySaysNotHeard(text: string): boolean {
  if (!NOT_HEARD.test(text)) return false;
  const rest = text
    .replace(NOT_HEARD, ' ')
    .replace(/[.,!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return !rest || !(asksWhyDetails(rest) || isAside(rest));
}

/** "Why do you need my phone, email and address?" and its many spellings. */
export function asksWhyDetails(text: string): boolean {
  const said = text.toLowerCase();
  return (
    /\b(why|what)\b/.test(said) &&
    /\b(need|want|use|using|for|do with)\b/.test(said) &&
    /\b(details?|etails|phone|number|email|e-mail|address|name|info|information|data)\b/.test(
      said,
    )
  );
}

/**
 * Honest and specific: what each detail is for. Nothing here promises more than the
 * platform does — the vendor and the rider do see the phone number and address.
 */
export const WHY_DETAILS =
  'Fair question. Your name and phone number let the vendor and rider reach you about ' +
  'this order, and the address tells the rider where to bring it. Your email is optional — ' +
  "it's only for your receipt, and to keep this chat on other phones — so you can skip it.";

/** When a question mid-checkout cannot be answered here. */
export const CANNOT_ANSWER_HERE =
  "I'm not sure about that one. Ask me again once your order is done, or say " +
  '"talk to a person" and I\'ll bring in our team.';
