import { extractAmounts } from '../discovery/price-guard';
import { BuyerSetup, KNOWN_AMOUNTS, ORDER_ON_ITS_WAY, Run } from './harness';

/**
 * Real things buyers say, and what a good answer must and must not do.
 *
 * The same questions run twice: through the keyword fallback in the unit tests, and
 * through the real model with `yarn chat:eval`. The model words things its own way, so
 * checks look for facts, not sentences.
 */

export type Mode = 'model' | 'fallback';

export interface Expect {
  /** Every pattern must appear in the last turn's replies. */
  says?: RegExp[];
  /** No pattern may appear in any reply. */
  neverSays?: RegExp[];
  /** The last turn asks whether they want a person, with the chips. */
  offersPerson?: boolean;
  /** Handed over (true), or never handed over (false). */
  handsOver?: boolean;
  /** The last turn shows dishes. */
  showsProducts?: boolean;
}

export interface Scenario {
  name: string;
  buyer: string[];
  setup?: BuyerSetup;
  /** Checked in both modes, then the mode's own on top. */
  expect: Expect;
  model?: Expect;
  fallback?: Expect;
}

/** Things James must never say, to anyone. */
const NEVER = [
  // No refund policy or promises — the team decides each case.
  /\b(full refund|refund within|refunded within|we will refund|you will be refunded|guarantee)/i,
  // Standard English, never Pidgin.
  /\b(abeg|wahala|i dey|sharp sharp|how far)\b/i,
];

const asksAboutPerson =
  /bring (in|them in) (someone|.*team)|someone from our team/i;

export const SCENARIOS: Scenario[] = [
  {
    name: 'a greeting',
    buyer: ['hello'],
    expect: { says: [/\S/], handsOver: false },
  },
  {
    name: 'small talk',
    buyer: ['how are you?'],
    expect: { handsOver: false },
    fallback: { says: [/doing well/i] },
  },
  {
    name: 'who James is',
    buyer: ['who are you?', 'what is your name?'],
    expect: { says: [/James/], handsOver: false },
  },
  {
    name: 'how Recommend works, explained',
    buyer: ['how does this work?'],
    expect: { says: [/cart|Pay/i], handsOver: false },
  },
  {
    name: 'an area we cover',
    buyer: ['do you deliver to Yaba?'],
    expect: { says: [/Yaba/], handsOver: false },
    fallback: { says: [/^Yes/] },
  },
  {
    name: 'an area we do not cover',
    buyer: ['do you deliver to Ajah?'],
    expect: {
      says: [/(don't|do not|not yet|no vendors|aren't|are not)/i],
      handsOver: false,
    },
  },
  {
    name: 'the delivery fee',
    buyer: ['how much is delivery?'],
    expect: { says: [/1,?500/], handsOver: false },
  },
  {
    name: 'the delivery time',
    buyer: ['how long does delivery take?'],
    expect: { says: [/20/, /30/], handsOver: false },
  },
  {
    name: 'paying',
    buyer: ['how do I pay?'],
    expect: { says: [/card|transfer/i], handsOver: false },
  },
  {
    name: 'pickup',
    buyer: ['can I pick it up myself?'],
    expect: { says: [/pick|collect/i], handsOver: false },
  },
  {
    name: 'their order, on its way',
    buyer: ['where is my order?'],
    setup: {
      context: {
        orderReferences: [ORDER_ON_ITS_WAY.reference],
        profile: { name: 'Ada Obi' },
        lastPaidAt: '2026-10-10T09:01:00.000Z',
      },
    },
    expect: { says: [/on its way|Tunde/i], handsOver: false },
  },
  {
    name: 'a search',
    buyer: ['jollof rice in Yaba'],
    expect: { showsProducts: true, handsOver: false },
  },
  {
    name: 'a refund',
    buyer: ['I want a refund for my last order'],
    expect: { offersPerson: true, handsOver: false },
  },
  {
    name: 'a cancellation',
    buyer: ['can I cancel my order?'],
    expect: { offersPerson: true, handsOver: false },
  },
  {
    name: 'an upset buyer',
    buyer: ['this is rubbish, my food came cold and late!!'],
    expect: { offersPerson: true, handsOver: false },
  },
  {
    name: 'asking for a person',
    buyer: ['I want to speak to someone'],
    expect: { says: [/passed this chat to our team/], handsOver: true },
  },
  {
    name: 'accepting the offer of a person',
    buyer: ['I want a refund', 'Yes, talk to a person'],
    expect: { says: [/passed this chat to our team/], handsOver: true },
  },
  {
    name: 'declining the offer of a person',
    buyer: ['I want a refund', 'No, keep chatting'],
    expect: { handsOver: false },
  },
  {
    name: 'gibberish, twice',
    buyer: ['asdkjh qwezx', 'asdkjh qwezx'],
    expect: { handsOver: false },
    // Two searches that found nothing: offered, not handed over.
    fallback: { offersPerson: true },
  },
  {
    name: 'a long conversation keeps its thread',
    buyer: [
      'hi',
      'I live in Ikeja',
      'what can I get?',
      'how much is delivery to me?',
      'thanks',
    ],
    expect: {
      says: [/welcome/i],
      // Every turn understood: the area, what is there, the fee, the thanks.
      neverSays: [/could not find anything matching/i, /bring in someone/i],
      handsOver: false,
    },
  },
];

const textOf = (replies: { text: string }[]) =>
  replies.map((reply) => reply.text).join('\n');

/** What went wrong in a run, if anything. Empty means it passed. */
export function check(scenario: Scenario, run: Run, mode: Mode): string[] {
  const expect: Expect = { ...scenario.expect, ...scenario[mode] };
  const problems: string[] = [];
  const last = run.turns[run.turns.length - 1];
  const lastText = textOf(last.replies);
  const allText = textOf(run.turns.flatMap((turn) => turn.replies));

  for (const pattern of expect.says ?? []) {
    if (!pattern.test(lastText)) problems.push(`should say ${pattern}`);
  }
  for (const pattern of [...NEVER, ...(expect.neverSays ?? [])]) {
    if (pattern.test(allText)) problems.push(`must never say ${pattern}`);
  }

  const invented = extractAmounts(allText).filter(
    (amount) => !KNOWN_AMOUNTS.includes(amount),
  );
  if (invented.length)
    problems.push(`invented amounts: ${invented.join(', ')}`);

  if (last.replies.length === 0) problems.push('left the buyer with no reply');

  if (expect.handsOver === true && run.handovers.length === 0) {
    problems.push('should have handed over');
  }
  if (expect.handsOver === false && run.handovers.length > 0) {
    problems.push(`handed over without consent: ${run.handovers.join('; ')}`);
  }

  if (expect.offersPerson) {
    const offered = last.replies.some(
      (reply) =>
        reply.payload?.kind === 'choices' &&
        (reply.payload.data as { purpose?: string }).purpose === 'teammate' &&
        asksAboutPerson.test(reply.text),
    );
    if (!offered) problems.push('should have offered a person');
  }

  if (
    expect.showsProducts &&
    !last.replies.some((reply) => reply.payload?.kind === 'product_list')
  ) {
    problems.push('should have shown dishes');
  }

  return problems;
}
