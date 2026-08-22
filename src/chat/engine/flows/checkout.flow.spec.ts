import { Test, TestingModule } from '@nestjs/testing';
import { CheckoutFlow } from './checkout.flow';
import { ConversationService } from '../../conversation/conversation.service';
import { ORDERING_PORT } from '../../ports/ordering.port';
import { IDENTITY_PORT } from '../../ports/identity.port';
import { CATALOG_PORT } from '../../ports/catalog.port';
import { CartChangedError } from '../../adapters/local-ordering.adapter';
import { ConversationState } from '../../enums/chat.enums';
import {
  Conversation,
  ConversationContext,
} from '../../conversation/entities/conversation.entity';

const CART = [{ productId: 'p1', quantity: 2 }];

const conversationAt = (
  state: ConversationState,
  context: ConversationContext = {},
): Conversation => ({ id: 'c1', state, context }) as Conversation;

describe('CheckoutFlow', () => {
  let flow: CheckoutFlow;
  let conversations: {
    mergeContext: jest.Mock;
    setState: jest.Mock;
    findById: jest.Mock;
  };
  let ordering: { placeCheckout: jest.Mock; deliveryFeeFor: jest.Mock };
  let identity: { upsertBuyer: jest.Mock };
  let catalog: { getProductById: jest.Mock };
  /** Whatever findById should return next — the flow re-reads after every merge. */
  let stored: ConversationContext;

  beforeEach(async () => {
    stored = {};
    conversations = {
      mergeContext: jest.fn((_id: string, patch: ConversationContext) => {
        stored = {
          ...stored,
          ...patch,
          profile: { ...stored.profile, ...patch.profile },
        };
        return Promise.resolve(null);
      }),
      setState: jest.fn(),
      findById: jest.fn(() =>
        Promise.resolve({ id: 'c1', context: stored } as Conversation),
      ),
    };
    ordering = {
      placeCheckout: jest.fn().mockResolvedValue({
        checkoutId: 'ck1',
        reference: 'REC-ABC',
        authorizationUrl: 'https://checkout.paystack.com/x',
        accessCode: 'acc_123',
        paystackPublicKey: 'pk_test_1',
        goodsTotal: 7000,
        deliveryFee: 1500,
        totalAmount: 8500,
      }),
      deliveryFeeFor: jest.fn((type: string) =>
        type === 'DELIVERY' ? 1500 : 0,
      ),
    };
    identity = { upsertBuyer: jest.fn().mockResolvedValue({ buyerId: 'b1' }) };
    catalog = {
      getProductById: jest.fn().mockResolvedValue({
        id: 'p1',
        name: 'Jollof Rice',
        price: 3500,
        vendorName: "Mama's Kitchen",
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckoutFlow,
        { provide: ConversationService, useValue: conversations },
        { provide: ORDERING_PORT, useValue: ordering },
        { provide: IDENTITY_PORT, useValue: identity },
        { provide: CATALOG_PORT, useValue: catalog },
      ],
    }).compile();

    flow = module.get<CheckoutFlow>(CheckoutFlow);
  });

  describe('starting', () => {
    it('refuses an empty cart without changing state', async () => {
      const replies = await flow.start(
        conversationAt(ConversationState.DISCOVERY),
        [],
      );

      expect(replies[0].text).toContain('empty');
      expect(conversations.setState).not.toHaveBeenCalled();
    });

    it('stores the cart and asks for a name first', async () => {
      const replies = await flow.start(
        conversationAt(ConversationState.DISCOVERY),
        CART,
      );

      expect(conversations.mergeContext).toHaveBeenCalledWith('c1', {
        pendingCart: CART,
      });
      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_NAME,
      );
      expect(replies[0].text).toContain('name');
    });

    it('skips questions it already has answers to', async () => {
      stored = { profile: { name: 'Ada', phone: '+2348012345678' } };

      await flow.start(conversationAt(ConversationState.DISCOVERY), CART);

      // Name and phone known → straight to fulfillment.
      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_FULFILLMENT,
      );
    });
  });

  describe('collecting details', () => {
    it('accepts a name and moves on', async () => {
      await flow.handle(
        conversationAt(ConversationState.COLLECTING_NAME),
        'Ada Obi',
      );

      expect(conversations.mergeContext).toHaveBeenCalledWith('c1', {
        profile: { name: 'Ada Obi' },
      });
    });

    it('re-asks rather than storing a one-character name', async () => {
      const replies = await flow.handle(
        conversationAt(ConversationState.COLLECTING_NAME),
        'A',
      );

      expect(conversations.setState).not.toHaveBeenCalled();
      expect(replies[0].text).toContain('name');
    });

    it('normalises a local phone number to E.164', async () => {
      await flow.handle(
        conversationAt(ConversationState.COLLECTING_PHONE),
        '0801 234 5678',
      );

      expect(conversations.mergeContext).toHaveBeenCalledWith('c1', {
        profile: { phone: '+2348012345678' },
      });
    });

    it('re-asks on an unparseable phone rather than advancing', async () => {
      const replies = await flow.handle(
        conversationAt(ConversationState.COLLECTING_PHONE),
        '12',
      );

      expect(conversations.setState).not.toHaveBeenCalled();
      expect(replies[0].text).toContain('phone number');
    });

    it.each([
      ['deliver it please', 'DELIVERY'],
      ['please bring it', 'DELIVERY'],
      ['I will pick it up', 'PICKUP'],
      ["I'll pick up", 'PICKUP'],
      ['collect', 'PICKUP'],
      ['I go come carry am', 'PICKUP'],
    ])('reads "%s" as %s', async (answer, expected) => {
      await flow.handle(
        conversationAt(ConversationState.COLLECTING_FULFILLMENT),
        answer,
      );

      expect(conversations.mergeContext).toHaveBeenCalledWith('c1', {
        profile: { fulfillmentType: expected },
      });
    });

    it('offers choices again when the answer is unclear', async () => {
      const replies = await flow.handle(
        conversationAt(ConversationState.COLLECTING_FULFILLMENT),
        'hmm',
      );

      expect(replies[0].payload?.kind).toBe('choices');
      expect(conversations.setState).not.toHaveBeenCalled();
    });

    it('asks for an address only when delivering', async () => {
      await flow.handle(
        conversationAt(ConversationState.COLLECTING_FULFILLMENT),
        'deliver',
      );
      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_ADDRESS,
      );

      conversations.setState.mockClear();
      stored = {};

      await flow.handle(
        conversationAt(ConversationState.COLLECTING_FULFILLMENT),
        'pickup',
      );
      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.CONFIRMING_ORDER,
      );
    });
  });

  describe('reading the order back', () => {
    it('quotes the delivery fee and total the buyer is about to be charged', async () => {
      stored = {
        profile: {
          name: 'Ada Obi',
          phone: '+2348012345678',
          fulfillmentType: 'DELIVERY',
          address: '12 Allen Avenue, Ikeja',
        },
        pendingCart: CART,
      };
      const replies = await flow.handle(
        conversationAt(ConversationState.COLLECTING_ADDRESS, stored),
        '12 Allen Avenue, Ikeja',
      );
      const summary = replies[replies.length - 1];

      expect(summary.payload?.kind).toBe('order_summary');
      expect(summary.payload?.data).toMatchObject({
        goodsTotal: 7000,
        deliveryFee: 1500,
        totalAmount: 8500,
        fulfillmentType: 'DELIVERY',
      });
      // The card is not the only place the buyer reads the figure.
      expect(summary.text).toContain('8,500');
    });

    it('charges nothing for delivery on a pickup order', async () => {
      stored = {
        profile: { name: 'Ada Obi', phone: '+2348012345678' },
        pendingCart: CART,
      };
      const replies = await flow.handle(
        conversationAt(ConversationState.COLLECTING_FULFILLMENT, stored),
        'pickup',
      );
      const summary = replies[replies.length - 1];

      expect(summary.payload?.data).toMatchObject({
        goodsTotal: 7000,
        deliveryFee: 0,
        totalAmount: 7000,
        fulfillmentType: 'PICKUP',
      });
    });
  });

  describe('confirming', () => {
    const ready = () =>
      conversationAt(ConversationState.CONFIRMING_ORDER, {
        profile: {
          name: 'Ada Obi',
          phone: '+2348012345678',
          fulfillmentType: 'PICKUP',
        },
        pendingCart: CART,
      });

    beforeEach(() => {
      stored = {
        profile: {
          name: 'Ada Obi',
          phone: '+2348012345678',
          fulfillmentType: 'PICKUP',
        },
        pendingCart: CART,
      };
    });

    it('does not place an order until the buyer says yes', async () => {
      const replies = await flow.handle(ready(), 'hmm');

      expect(ordering.placeCheckout).not.toHaveBeenCalled();
      expect(replies[0].payload?.kind).toBe('choices');
    });

    it('abandons cleanly on no, charging nothing', async () => {
      const replies = await flow.handle(ready(), 'no');

      expect(ordering.placeCheckout).not.toHaveBeenCalled();
      expect(replies[0].text).toContain('nothing has been charged');
      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.DISCOVERY,
      );
    });

    it('creates the buyer record before placing the order', async () => {
      await flow.handle(ready(), 'yes');

      expect(identity.upsertBuyer).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Ada Obi', phone: '+2348012345678' }),
      );
      expect(ordering.placeCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ buyerId: 'b1', lines: CART }),
      );
    });

    it('returns a payment_link carrying the inline access code', async () => {
      const replies = await flow.handle(ready(), 'yes');

      expect(replies[0].payload?.kind).toBe('payment_link');
      expect(replies[0].payload?.data).toEqual(
        expect.objectContaining({
          reference: 'REC-ABC',
          accessCode: 'acc_123',
          publicKey: 'pk_test_1',
          totalAmount: 8500,
        }),
      );
    });

    it('remembers the reference so the webhook can find this conversation', async () => {
      await flow.handle(ready(), 'yes');

      expect(conversations.mergeContext).toHaveBeenCalledWith('c1', {
        pendingCheckoutId: 'ck1',
        pendingPaymentReference: 'REC-ABC',
        // Appended as well as marked pending: the pending marker is cleared once the
        // payment lands, and the Orders tab still has to find the order afterwards.
        orderReferences: ['REC-ABC'],
      });
      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.AWAITING_PAYMENT,
      );
    });

    it('explains a changed cart in words instead of an error', async () => {
      ordering.placeCheckout.mockRejectedValue(
        new CartChangedError({
          code: 'CART_CHANGED',
          changes: [
            {
              productId: 'p1',
              productName: 'Jollof Rice',
              reason: 'PRICE_CHANGED',
              currentUnitPrice: 4000,
            },
          ],
        }),
      );

      const replies = await flow.handle(ready(), 'yes');

      expect(replies[0].text).toContain('Jollof Rice');
      expect(replies[0].text).toContain('4,000');
      expect(replies[0].text).toContain('Nothing has been charged');
    });

    it('does not strand the buyer when payment setup fails', async () => {
      ordering.placeCheckout.mockRejectedValue(new Error('Paystack down'));

      const replies = await flow.handle(ready(), 'yes');

      expect(replies[0].text).toContain('Nothing has been charged');
      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.DISCOVERY,
      );
    });
  });

  describe('escape hatches', () => {
    it.each(['cancel', 'forget it', 'add something else'])(
      'lets the buyer out with "%s"',
      async (answer) => {
        const replies = await flow.handle(
          conversationAt(ConversationState.COLLECTING_PHONE),
          answer,
        );

        expect(conversations.setState).toHaveBeenCalledWith(
          'c1',
          ConversationState.DISCOVERY,
        );
        expect(replies[0].text).toContain('cart is still here');
      },
    );

    it('says it is waiting rather than re-asking while payment is pending', async () => {
      const replies = await flow.handle(
        conversationAt(ConversationState.AWAITING_PAYMENT),
        'hello?',
      );

      expect(replies[0].text).toContain('waiting for the payment');
      expect(ordering.placeCheckout).not.toHaveBeenCalled();
    });
  });
});
