import { mergeConversations } from './merge';
import { ConversationState } from '../enums/chat.enums';
import type { Conversation } from '../conversation/entities/conversation.entity';

const at = (iso: string) => new Date(iso);

const conversation = (over: Partial<Conversation>): Conversation =>
  ({
    id: 'c',
    state: ConversationState.DISCOVERY,
    context: {},
    buyerId: null,
    areaId: null,
    lastMessageAt: null,
    heldByAdminId: null,
    heldAt: null,
    lastAdminMessageAt: null,
    needsAttentionAt: null,
    attentionReason: null,
    handoverRequestedAt: null,
    handoverReason: null,
    ...over,
  }) as Conversation;

describe('mergeConversations', () => {
  const home = conversation({
    id: 'home',
    state: ConversationState.DISCOVERY,
    lastMessageAt: at('2026-10-01T10:00:00Z'),
    areaId: 'lekki',
    buyerId: 'buyer-1',
    context: {
      profile: { name: 'Ada', phone: '+2348011111111' },
      orderReferences: ['REC-OLD'],
      pendingCart: [{ productId: 'p-home', quantity: 1 }],
    },
  });

  it('lets the thread the buyer spoke in last lead', () => {
    const incoming = conversation({
      id: 'incoming',
      state: ConversationState.COLLECTING_ADDRESS,
      lastMessageAt: at('2026-10-08T09:00:00Z'),
      areaId: 'ajah',
      context: {
        profile: { name: 'Ada O.' },
        pendingCart: [{ productId: 'p-new', quantity: 2 }],
      },
    });

    const merged = mergeConversations(home, incoming, true, 'ada@example.com');

    expect(merged.state).toBe(ConversationState.COLLECTING_ADDRESS);
    expect(merged.areaId).toBe('ajah');
    expect(merged.context.pendingCart).toEqual([
      { productId: 'p-new', quantity: 2 },
    ]);
    expect(merged.lastMessageAt).toEqual(at('2026-10-08T09:00:00Z'));
  });

  it('keeps every order and the details from both, with the verified email', () => {
    const incoming = conversation({
      lastMessageAt: at('2026-10-08T09:00:00Z'),
      context: { profile: { name: 'Ada O.' }, orderReferences: ['REC-NEW'] },
    });

    const merged = mergeConversations(home, incoming, true, 'ada@example.com');

    expect(merged.context.orderReferences).toEqual(['REC-OLD', 'REC-NEW']);
    expect(merged.context.profile).toEqual({
      name: 'Ada O.',
      phone: '+2348011111111',
      email: 'ada@example.com',
    });
    expect(merged.buyerId).toBe('buyer-1');
  });

  it('keeps an unpaid payment from the older thread, so its confirmation lands', () => {
    const waiting = conversation({
      ...home,
      context: {
        ...home.context,
        pendingPaymentReference: 'REC-PAY',
        pendingCheckoutId: 'checkout-1',
      },
    });
    const incoming = conversation({
      lastMessageAt: at('2026-10-08T09:00:00Z'),
    });

    const merged = mergeConversations(
      waiting,
      incoming,
      true,
      'ada@example.com',
    );

    expect(merged.context.pendingPaymentReference).toBe('REC-PAY');
    expect(merged.context.pendingCheckoutId).toBe('checkout-1');
  });

  it('does not let a browser that only saw the greeting take over', () => {
    const greetedOnly = conversation({
      lastMessageAt: at('2026-10-08T09:00:00Z'),
    });

    const merged = mergeConversations(
      home,
      greetedOnly,
      false,
      'ada@example.com',
    );

    expect(merged.state).toBe(home.state);
    expect(merged.areaId).toBe('lekki');
    expect(merged.context.pendingCart).toEqual(home.context.pendingCart);
  });

  it('remembers them as a returning buyer, with their most recent paid address', () => {
    const paidHere = conversation({
      ...home,
      context: {
        ...home.context,
        lastPaidAt: '2026-09-01T10:00:00.000Z',
        lastDeliveryAddress: 'Old place, Yaba',
      },
    });
    // The newer browser paid more recently, somewhere else.
    const paidThere = conversation({
      lastMessageAt: at('2026-10-08T09:00:00Z'),
      context: {
        lastPaidAt: '2026-10-05T10:00:00.000Z',
        lastDeliveryAddress: '12 Admiralty Way, Lekki',
      },
    });

    const merged = mergeConversations(
      paidHere,
      paidThere,
      true,
      'ada@example.com',
    );

    expect(merged.context.lastPaidAt).toBe('2026-10-05T10:00:00.000Z');
    expect(merged.context.lastDeliveryAddress).toBe('12 Admiralty Way, Lekki');
  });

  it('keeps the remembered address even when the thread without it leads', () => {
    const paidHere = conversation({
      ...home,
      context: {
        ...home.context,
        lastPaidAt: '2026-09-01T10:00:00.000Z',
        lastDeliveryAddress: 'Old place, Yaba',
      },
    });
    const neverPaid = conversation({
      lastMessageAt: at('2026-10-08T09:00:00Z'),
    });

    const merged = mergeConversations(
      paidHere,
      neverPaid,
      true,
      'ada@example.com',
    );

    expect(merged.context.lastDeliveryAddress).toBe('Old place, Yaba');
  });

  it('keeps a person on the thread they were answering', () => {
    const held = conversation({
      lastMessageAt: at('2026-10-08T09:00:00Z'),
      heldByAdminId: 'admin-1',
      heldAt: at('2026-10-08T08:00:00Z'),
      handoverRequestedAt: at('2026-10-08T07:00:00Z'),
      handoverReason: 'Asked for a person',
    });

    const merged = mergeConversations(home, held, true, 'ada@example.com');

    expect(merged.heldByAdminId).toBe('admin-1');
    expect(merged.handoverReason).toBe('Asked for a person');
  });
});
