import type { AreaSummary } from '../../ports/location.port';
import { WHY_DETAILS, asksWhyDetails } from '../flows/aside';

/**
 * What the assistant knows about Recommend.
 *
 * Kept in one place so a change in how the business works is one edit here. Anything
 * that can change without a deploy — the delivery fee, the areas we cover — is passed in
 * from the system, never written down, so James cannot quote a stale figure.
 */

/** Same details as the customer app's Help & contact and the website's contact page. */
export const SUPPORT_PHONE = '+234 814 306 7676';
export const SUPPORT_EMAIL = 'contacts.recommend@gmail.com';
export const SUPPORT_HOURS =
  'Monday to Friday 8am to 9pm, and Saturday 9am to 8pm';

export const DELIVERY_TIME =
  'usually 20 to 30 minutes, a little longer at busy times or in the rain';

export interface RecommendFacts {
  /** The flat delivery fee, from configuration. */
  deliveryFee: number;
  /** Areas with at least one approved vendor. */
  servedAreas: AreaSummary[];
  /** Whether buyers may collect orders themselves (`PICKUP_ENABLED`). */
  pickupEnabled: boolean;
}

/** What James says about pickup while it is switched off. */
export const PICKUP_COMING_SOON =
  "Pickup isn't available just yet — it's coming soon. For now, every order is delivered.";

export function naira(amount: number): string {
  return `₦${amount.toLocaleString('en-US')}`;
}

/** How many areas to name before summarising the rest. */
const AREAS_NAMED = 40;

export function describeAreas(areas: AreaSummary[]): string {
  if (areas.length === 0) return 'none yet';
  const named = areas
    .slice(0, AREAS_NAMED)
    .map((area) => `${area.name} (${area.stateName})`);
  const more = areas.length - named.length;
  return more > 0 ? `${named.join(', ')} and ${more} more` : named.join(', ');
}

/** The knowledge section of the system prompt, built fresh for each reply. */
export function buildKnowledge(facts: RecommendFacts): string {
  const fee = naira(facts.deliveryFee);
  const pickup = facts.pickupEnabled
    ? `- Pickup: free. Once the order is ready, the buyer is told where to collect it, and shows
  the collection code from their Orders tab at the counter.`
    : `- Pickup: not available yet — it is coming soon. Every order is delivered for now. Never
  offer pickup or suggest the buyer collect an order themselves. If asked, say it is
  coming soon.`;

  return `
WHAT YOU KNOW ABOUT RECOMMEND
Use these facts to answer questions about how Recommend works. They are the only facts
about the business you may state — if something is not here, say you are not sure.

- What it is: a chat where people find and order from vendors near them. Food first, but
  vendors sell anything — the buyer just says what they want.
- Ordering: the buyer asks, sees options as cards, opens a vendor or adds items to their
  cart, then taps Pay. Before payment, they may be offered extras from the same vendor
  (drinks, sides), then asked for their name, phone number, an optional email for the
  receipt, and ${facts.pickupEnabled ? 'whether it is delivery or pickup' : 'their delivery address'}. They see a
  summary and pay right here in the chat.
- Delivery: a flat ${fee} wherever we deliver, whatever the order. Delivery takes
  ${DELIVERY_TIME}. Never promise an exact time. When the rider arrives, the buyer reads
  them the delivery code shown in their Orders tab.
${pickup}
- Payment: through Paystack — card, bank transfer or USSD, whichever they prefer at
  checkout. A receipt goes to their email if they gave one.
- Their orders: the Orders tab (bottom of the screen) shows every order, its progress, the
  rider and the code. "I've received this" there confirms it arrived. You can look up
  their orders yourself with get_my_orders.
- Signing in: optional, with their email, from the menu at the top right. It keeps their
  chats and orders on any phone or browser.
- Why we ask for details: the name and phone number let the vendor and rider reach the
  buyer about their order; the address tells the rider where to bring it; the email is
  optional — only for the receipt, and to keep the chat on other phones — and can be
  skipped.
- Areas we cover right now: ${describeAreas(facts.servedAreas)}. If someone asks about a
  place that is not listed, say we do not have vendors there yet.
- Talking to the team: ${SUPPORT_PHONE}, or ${SUPPORT_EMAIL}. Open ${SUPPORT_HOURS}. You can
  also bring the team into this chat (request_teammate).
- Recommend was founded by Chanor James.
`.trim();
}

/**
 * A question about how Recommend works, recognised without a model. Each answer comes
 * from the same facts the prompt gives the model, so both paths say the same thing.
 */
export type KnowledgeAnswer =
  | { kind: 'text'; text: string }
  /** "Where is my order?" — answered from their orders. */
  | { kind: 'orders' }
  /** Something only the team can sort out — offer them, with this reason. */
  | { kind: 'team'; reason: string }
  /** Whether we cover a place — answered from the areas named in the message. */
  | { kind: 'coverage' };

export function answerFromKnowledge(
  text: string,
  facts: RecommendFacts,
): KnowledgeAnswer | null {
  const said = ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
  const has = (pattern: RegExp) => pattern.test(said);

  if (
    has(
      /\b(refund|money back|cancel|cancell?ation|wrong order|missing item|complain)/,
    )
  ) {
    return {
      kind: 'team',
      reason: `Asked about: ${text.trim().slice(0, 120)}`,
    };
  }

  // Unhappy with something that already happened — the team should hear about it.
  if (
    has(
      /\b(rubbish|terrible|awful|horrible|disappointed|angry|worst|nonsense|unacceptable|cold|late|spoilt|spoiled|stale)\b/,
    ) &&
    has(/\b(food|order|delivery|rider|meal|package|came)\b/)
  ) {
    return { kind: 'team', reason: `Unhappy: ${text.trim().slice(0, 120)}` };
  }

  if (
    // "where's" arrives as "where s" once punctuation is gone.
    has(/\bwhere( ?s| is)? my (order|food|package|delivery)\b/) ||
    has(/\b(track|status of) (my )?order\b/) ||
    has(/\bmy order\b.*\b(status|coming|arrive|ready|late)\b/)
  ) {
    return { kind: 'orders' };
  }

  // Every question the message asks is answered — "how much is delivery, and how do
  // I pay?" gets both — in the order below.
  const answers: string[] = [];

  // First: "why do you need my phone number?" is about us asking, not about calling us.
  const aboutDetails = asksWhyDetails(text);
  if (aboutDetails) answers.push(WHY_DETAILS);

  const fee = has(
    /\bdeliver(y|ies)? (fee|cost|charge|price)\b|\bhow much (is|for) delivery\b/,
  );
  if (fee) {
    answers.push(
      `Delivery is a flat ${naira(facts.deliveryFee)} wherever we deliver` +
        (facts.pickupEnabled ? ', and pickup is free' : '') +
        `. It ${DELIVERY_TIME.replace(/^usually/, 'usually takes')}.`,
    );
  }

  // The fee answer already gives the time.
  if (
    !fee &&
    has(/\bhow (long|fast|soon)\b/) &&
    has(/\b(deliver|delivery|arrive|take|come)\b/)
  ) {
    answers.push(
      `Delivery ${DELIVERY_TIME.replace(/^usually/, 'usually takes')}.`,
    );
  }

  if (
    has(/\b(pick ?up|pick (it|them) up|collect)\b/) &&
    has(/\b(how|can i|do you|is there)\b/)
  ) {
    answers.push(
      facts.pickupEnabled
        ? 'Yes — choose pickup at checkout and it is free. Once your order is ready, ' +
            "we'll tell you where to collect it, and you show the collection code from your " +
            'Orders tab at the counter.'
        : PICKUP_COMING_SOON,
    );
  }

  if (
    has(/\bhow (do|can) i pay\b|\bpayment (method|option)s?\b/) ||
    has(/\b(pay|payment)\b.*\b(card|transfer|ussd|cash)\b/)
  ) {
    answers.push(
      'You pay right here in the chat through Paystack — by card, bank transfer or ' +
        'USSD, whichever you prefer. Add what you want to your cart and tap Pay when ready.',
    );
  }

  if (
    !aboutDetails &&
    has(/\b(contact|phone number|email|call you|customer care number)\b/)
  ) {
    answers.push(
      `You can call us on ${SUPPORT_PHONE} or email ${SUPPORT_EMAIL} — we're open ` +
        `${SUPPORT_HOURS}. Or just ask here and I'll bring the team in.`,
    );
  }

  if (has(/\bhow (does|do) (this|it|recommend) work\b|\bwhat is recommend\b/)) {
    answers.push(
      'Tell me what you want and roughly where you are, and I’ll show you vendors near ' +
        'you who have it. Add items to your cart, tap Pay, and pay right here in the chat — ' +
        `then it’s delivered for ${naira(facts.deliveryFee)}` +
        (facts.pickupEnabled ? ', or you pick it up for free.' : '.'),
    );
  }

  if (answers.length > 0) return { kind: 'text', text: answers.join(' ') };

  if (
    has(/\b(which|what) (areas|locations|places)\b/) ||
    has(/\bwhere do you (deliver|operate|cover|work)\b/) ||
    has(/\bdo you (deliver|operate|cover|work) (to|in|at|around)\b/)
  ) {
    return { kind: 'coverage' };
  }

  return null;
}
