/**
 * Take the model's own list of items out of a reply that shows them as cards.
 *
 * The prompt says not to list them, and the model often does anyway — numbered, bulleted,
 * or run together on one line — so the buyer reads every item twice, once in prose and
 * once on the card. What is left is the sentence around the list: "I couldn't find
 * exactly that, but here are some close options:". Markdown bold goes too; the chat shows
 * it as asterisks.
 *
 * Only for replies with cards. A list in a reply without them is the only place the
 * buyer would see it.
 */
export function stripCardEcho(text: string): string {
  const kept = text.split('\n').flatMap((line) => {
    if (LIST_ITEM.test(line)) return [];
    // A list run into one line: "Here are some: 1. **A** from X. 2. **B** from Y."
    const inline = line.search(INLINE_LIST);
    return [inline >= 0 ? line.slice(0, inline) : line];
  });

  return kept
    .join('\n')
    .replace(/\*\*|__/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A line that is an item: "1. Jollof", "2) Suya", "- Jollof", "* Jollof", "• Jollof". */
const LIST_ITEM = /^\s*(?:\d{1,2}[.)]|[-*•])\s+\S/;

/** A numbered list inside a line: a "1." that is later followed by a "2.". */
const INLINE_LIST = /\s1[.)]\s+\S.*?\s2[.)]\s+\S/;
