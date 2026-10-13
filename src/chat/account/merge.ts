import type {
  Conversation,
  ConversationContext,
} from '../conversation/entities/conversation.entity';

/** The fields of the account's conversation that change when another is folded in. */
export type MergedFields = Pick<
  Conversation,
  | 'state'
  | 'context'
  | 'buyerId'
  | 'areaId'
  | 'lastMessageAt'
  | 'heldByAdminId'
  | 'heldAt'
  | 'lastAdminMessageAt'
  | 'needsAttentionAt'
  | 'attentionReason'
  | 'handoverRequestedAt'
  | 'handoverReason'
>;

/**
 * What the account's conversation (`home`) looks like after `incoming` — the one the
 * buyer was just using on another browser — is folded into it.
 *
 * Whichever the buyer spoke in most recently leads: its stage of checkout, its cart, its
 * area. Nothing that matters is dropped from the other — every order reference is kept,
 * an unpaid payment is kept so its confirmation still finds this thread, and a person
 * already looking after either side stays on it.
 *
 * `incomingHasBuyerMessages` is false for a browser that only received the greeting: it
 * has nothing to contribute, and must not lead just because its greeting is newer.
 */
export function mergeConversations(
  home: Conversation,
  incoming: Conversation,
  incomingHasBuyerMessages: boolean,
  verifiedEmail: string,
): MergedFields {
  const incomingLeads =
    incomingHasBuyerMessages &&
    time(incoming.lastMessageAt) > time(home.lastMessageAt);
  const lead = incomingLeads ? incoming : home;
  const other = incomingLeads ? home : incoming;

  const leadContext = lead.context ?? {};
  const otherContext = other.context ?? {};

  // The unpaid payment, as a pair — the reference and the checkout belong together.
  const pending = leadContext.pendingPaymentReference
    ? leadContext
    : otherContext.pendingPaymentReference
      ? otherContext
      : null;

  const paidLater =
    (otherContext.lastPaidAt ?? '') > (leadContext.lastPaidAt ?? '')
      ? otherContext
      : leadContext;
  const paidEarlier = paidLater === leadContext ? otherContext : leadContext;

  const context: ConversationContext = {
    ...leadContext,
    profile: {
      ...otherContext.profile,
      ...leadContext.profile,
      email: verifiedEmail,
    },
    orderReferences: unique([
      ...(home.context?.orderReferences ?? []),
      ...(incoming.context?.orderReferences ?? []),
    ]),
    pendingPaymentReference: pending?.pendingPaymentReference,
    pendingCheckoutId: pending?.pendingCheckoutId,
    // What a returning buyer is remembered by survives from whichever side has it —
    // the address from the side that paid most recently, else the other's.
    lastPaidAt: laterOf(leadContext.lastPaidAt, otherContext.lastPaidAt),
    lastDeliveryAddress:
      paidLater.lastDeliveryAddress ?? paidEarlier.lastDeliveryAddress,
  };

  // A hold or a flag already on the account's thread wins; otherwise one on the
  // incoming thread comes across, so an admin mid-conversation is not cut off.
  const held = home.heldByAdminId ? home : incoming;
  const flagged = home.needsAttentionAt ? home : incoming;
  const asked = home.handoverRequestedAt ? home : incoming;

  return {
    state: lead.state,
    context,
    buyerId: home.buyerId ?? incoming.buyerId,
    areaId: lead.areaId ?? other.areaId,
    lastMessageAt: latest(home.lastMessageAt, incoming.lastMessageAt),
    heldByAdminId: held.heldByAdminId,
    heldAt: held.heldAt,
    lastAdminMessageAt: held.lastAdminMessageAt,
    needsAttentionAt: flagged.needsAttentionAt,
    attentionReason: flagged.attentionReason,
    handoverRequestedAt: asked.handoverRequestedAt,
    handoverReason: asked.handoverReason,
  };
}

function time(date: Date | null): number {
  return date ? new Date(date).getTime() : 0;
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return time(a) >= time(b) ? a : b;
}

/** The later of two ISO timestamps, either of which may be missing. */
function laterOf(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
