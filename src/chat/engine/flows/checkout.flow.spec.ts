import { Test, TestingModule } from '@nestjs/testing';
import { CheckoutFlow } from './checkout.flow';
import { ConversationService } from '../../conversation/conversation.service';
import { ORDERING_PORT } from '../../ports/ordering.port';
import { IDENTITY_PORT } from '../../ports/identity.port';
import { CATALOG_PORT } from '../../ports/catalog.port';
import { LOCATION_PORT } from '../../ports/location.port';
import { CartChangedError } from '../../adapters/local-ordering.adapter';
import { ConversationState } from '../../enums/chat.enums';
import {
  Conversation,
  ConversationContext,
} from '../../conversation/entities/conversation.entity';

const CART = [{ productId: 'p1', quantity: 2 }];

const IKEJA = { id: 'a-ikeja', name: 'Ikeja', stateName: 'Lagos' };
const YABA = { id: 'a-yaba', name: 'Yaba', stateName: 'Lagos' };
/** Exists, but no vendor serves it. */
const AJAH = { id: 'a-ajah', name: 'Ajah', stateName: 'Lagos' };
const AREAS = [IKEJA, YABA, AJAH];

const ASK_ADDRESS =
  "What's the full delivery address? House number, street and area.";

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
  let ordering: {
    placeCheckout: jest.Mock;
    deliveryFeeFor: jest.Mock;
    pickupEnabled: jest.Mock;
  };
  let identity: { upsertBuyer: jest.Mock };
  let catalog: {
    getProductById: jest.Mock;
    listAddOns: jest.Mock;
    getVendorById: jest.Mock;
  };
  let locations: {
    searchAreas: jest.Mock;
    listServedAreas: jest.Mock;
    getAreaById: jest.Mock;
  };
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
      // On here, so the pickup path stays tested for the day it is switched back on.
      // "while pickup is switched off" covers the setting production ships with.
      pickupEnabled: jest.fn().mockReturnValue(true),
    };
    identity = { upsertBuyer: jest.fn().mockResolvedValue({ buyerId: 'b1' }) };
    catalog = {
      getProductById: jest.fn().mockResolvedValue({
        id: 'p1',
        name: 'Jollof Rice',
        price: 3500,
        vendorId: 'v1',
        vendorName: "Mama's Kitchen",
        isAddOn: false,
      }),
      // No vendor has extras unless a test says so.
      listAddOns: jest.fn().mockResolvedValue([]),
      // Delivers to both areas we cover unless a test says otherwise.
      getVendorById: jest.fn().mockResolvedValue({
        id: 'v1',
        name: "Mama's Kitchen",
        areas: [IKEJA, YABA],
      }),
    };
    locations = {
      // Like the real search: every area named in the text.
      searchAreas: jest.fn((text: string) =>
        Promise.resolve(
          AREAS.filter((area) =>
            text.toLowerCase().includes(area.name.toLowerCase()),
          ),
        ),
      ),
      listServedAreas: jest.fn().mockResolvedValue([IKEJA, YABA]),
      getAreaById: jest.fn((id: string) =>
        Promise.resolve(AREAS.find((area) => area.id === id) ?? null),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckoutFlow,
        { provide: ConversationService, useValue: conversations },
        { provide: ORDERING_PORT, useValue: ordering },
        { provide: IDENTITY_PORT, useValue: identity },
        { provide: CATALOG_PORT, useValue: catalog },
        { provide: LOCATION_PORT, useValue: locations },
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

      // Name and phone known → on to the receipt email.
      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_EMAIL,
      );
    });

    it('never asks a signed-in buyer for their email', async () => {
      stored = { profile: { name: 'Ada', phone: '+2348012345678' } };
      conversations.findById.mockResolvedValue({
        id: 'c1',
        accountId: 'account-1',
        context: stored,
      });

      await flow.start(conversationAt(ConversationState.DISCOVERY), CART);

      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_FULFILLMENT,
      );
    });

    it('does not ask again once the buyer has skipped it', async () => {
      stored = {
        profile: { name: 'Ada', phone: '+2348012345678' },
        receiptEmailSkipped: true,
      };

      await flow.start(conversationAt(ConversationState.DISCOVERY), CART);

      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_FULFILLMENT,
      );
    });
  });

  describe('add-ons', () => {
    const water = {
      id: 'w1',
      name: 'Bottled water',
      price: 300,
      imageUrl: null,
      vendorId: 'v1',
      vendorName: "Mama's Kitchen",
      isAddOn: true,
    };
    const beef = { ...water, id: 'b1', name: 'Extra beef', price: 800 };

    it('offers the vendor’s extras once, right after Pay', async () => {
      catalog.listAddOns.mockResolvedValue([water, beef]);

      const replies = await flow.start(
        conversationAt(ConversationState.DISCOVERY),
        CART,
      );

      expect(catalog.listAddOns).toHaveBeenCalledWith(['v1']);
      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.OFFERING_ADDONS,
      );
      expect(stored.addOnsOffered).toBe(true);
      expect(replies[0].text).toBe('Anything to go with it?');
      expect(replies[0].payload).toEqual({
        kind: 'addon_offer',
        data: {
          vendors: [
            {
              vendorId: 'v1',
              vendorName: "Mama's Kitchen",
              items: [
                {
                  productId: 'w1',
                  name: 'Bottled water',
                  price: 300,
                  imageUrl: null,
                },
                {
                  productId: 'b1',
                  name: 'Extra beef',
                  price: 800,
                  imageUrl: null,
                },
              ],
            },
          ],
        },
      });
    });

    it('skips the step when no vendor in the cart has extras', async () => {
      await flow.start(conversationAt(ConversationState.DISCOVERY), CART);

      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_NAME,
      );
    });

    it('does not offer twice for the same order', async () => {
      catalog.listAddOns.mockResolvedValue([water]);
      stored = { addOnsOffered: true };

      await flow.start(conversationAt(ConversationState.DISCOVERY), CART);

      expect(conversations.setState).not.toHaveBeenCalledWith(
        'c1',
        ConversationState.OFFERING_ADDONS,
      );
    });

    it('offers only for vendors with a main item — never for an add-on alone', async () => {
      catalog.getProductById.mockResolvedValue({ ...water });
      catalog.listAddOns.mockResolvedValue([]);

      await flow.start(conversationAt(ConversationState.DISCOVERY), [
        { productId: 'w1', quantity: 1 },
      ]);

      expect(catalog.listAddOns).toHaveBeenCalledWith([]);
    });

    it('adds the picked extras to the cart, at the database price, then carries on', async () => {
      catalog.listAddOns.mockResolvedValue([water, beef]);
      stored = { pendingCart: [...CART] };

      const { added, replies } = await flow.addAddOns(
        conversationAt(ConversationState.OFFERING_ADDONS, stored),
        [
          { productId: 'w1', quantity: 2 },
          { productId: 'b1', quantity: 1 },
        ],
      );

      expect(added).toBe('2 × Bottled water, 1 × Extra beef');
      expect(stored.pendingCart).toEqual([
        { productId: 'p1', quantity: 2 },
        { productId: 'w1', quantity: 2, expectedUnitPrice: 300 },
        { productId: 'b1', quantity: 1, expectedUnitPrice: 800 },
      ]);
      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_NAME,
      );
      expect(replies[0].text).toContain('name');
    });

    it('ignores anything that is not one of the offered extras', async () => {
      catalog.listAddOns.mockResolvedValue([water]);
      stored = { pendingCart: [...CART] };

      const { added } = await flow.addAddOns(
        conversationAt(ConversationState.OFFERING_ADDONS, stored),
        [
          { productId: 'some-main-dish', quantity: 3 },
          { productId: 'w1', quantity: 0 },
        ],
      );

      expect(added).toBeNull();
      expect(stored.pendingCart).toEqual(CART);
    });

    it('caps a quantity at 50', async () => {
      catalog.listAddOns.mockResolvedValue([water]);
      stored = { pendingCart: [...CART] };

      await flow.addAddOns(
        conversationAt(ConversationState.OFFERING_ADDONS, stored),
        [{ productId: 'w1', quantity: 500 }],
      );

      expect(stored.pendingCart?.[1]).toMatchObject({ quantity: 50 });
    });

    it('changes nothing when the card is answered after the checkout moved on', async () => {
      const { replies } = await flow.addAddOns(
        conversationAt(ConversationState.COLLECTING_PHONE),
        [{ productId: 'w1', quantity: 1 }],
      );

      expect(replies).toEqual([]);
      expect(catalog.listAddOns).not.toHaveBeenCalled();
    });

    it('moves on when the buyer types no', async () => {
      await flow.handle(
        conversationAt(ConversationState.OFFERING_ADDONS, {
          pendingCart: CART,
        }),
        'No, thanks',
      );

      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_NAME,
      );
    });

    it('points back to the card rather than guessing a typed item', async () => {
      catalog.listAddOns.mockResolvedValue([water]);

      const replies = await flow.handle(
        conversationAt(ConversationState.OFFERING_ADDONS, {
          pendingCart: CART,
        }),
        'add coke',
      );

      expect(conversations.setState).not.toHaveBeenCalled();
      expect(replies[0].payload?.kind).toBe('addon_offer');
    });
  });

  describe('while pickup is switched off', () => {
    const returning: ConversationContext = {
      profile: { name: 'Ada Obi', phone: '+2348012345678' },
      lastPaidAt: '2026-10-01T10:00:00.000Z',
      lastDeliveryAddress: '12 Admiralty Way, Lekki',
    };

    beforeEach(() => ordering.pickupEnabled.mockReturnValue(false));

    it('never asks a new buyer to choose — straight to the address, as a delivery', async () => {
      stored = {
        profile: { name: 'Ada', phone: '+2348012345678' },
        receiptEmailSkipped: true,
      };

      const replies = await flow.start(
        conversationAt(ConversationState.DISCOVERY),
        CART,
      );

      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_ADDRESS,
      );
      expect(replies[0].text).toBe(ASK_ADDRESS);
      // Recorded: an unset fulfilment would be read as pickup at the summary.
      expect(stored.profile?.fulfillmentType).toBe('DELIVERY');
    });

    it('offers a returning buyer their address, without a pickup button', async () => {
      stored = { ...returning };

      const replies = await flow.start(
        conversationAt(ConversationState.DISCOVERY),
        CART,
      );

      expect(replies[0].payload).toEqual({
        kind: 'choices',
        data: {
          purpose: 'fulfillment',
          options: [
            { id: 'SAME', label: 'Yes, same address' },
            { id: 'NEW', label: 'New address' },
          ],
        },
      });
    });

    it('turns down a returning buyer who types pickup, and asks again', async () => {
      stored = { ...returning };

      const replies = await flow.handle(
        conversationAt(ConversationState.COLLECTING_FULFILLMENT, returning),
        "I'll pick it up",
      );

      expect(replies[0].text).toBe(
        "Pickup isn't available just yet — we'll deliver it to you. Should we deliver to 12 Admiralty Way, Lekki again?",
      );
      expect(stored.profile?.fulfillmentType).toBeUndefined();
      expect(conversations.setState).not.toHaveBeenCalled();
    });

    it('does not take "I’ll pick it up" as an address', async () => {
      const replies = await flow.handle(
        conversationAt(ConversationState.COLLECTING_ADDRESS),
        "I'll pick it up myself",
      );

      expect(replies[0].text).toBe(
        `Pickup isn't available just yet — we'll deliver it to you. ${ASK_ADDRESS}`,
      );
      expect(stored.profile?.address).toBeUndefined();
    });

    it('moves a checkout already waiting on the question on to the address', async () => {
      // Asked "delivered or picked up?" before pickup was switched off.
      const replies = await flow.handle(
        conversationAt(ConversationState.COLLECTING_FULFILLMENT),
        'pickup',
      );

      expect(stored.profile?.fulfillmentType).toBe('DELIVERY');
      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_ADDRESS,
      );
      expect(replies[0].text).toMatch(/^Pickup isn't available just yet/);
    });
  });

  describe('a returning buyer', () => {
    const returning: ConversationContext = {
      profile: { name: 'Ada Obi', phone: '+2348012345678' },
      lastPaidAt: '2026-10-01T10:00:00.000Z',
      lastDeliveryAddress: '12 Admiralty Way, Lekki',
    };

    it('is asked nothing but where it goes — name, phone and email are skipped', async () => {
      stored = { ...returning };

      const replies = await flow.start(
        conversationAt(ConversationState.DISCOVERY),
        CART,
      );

      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_FULFILLMENT,
      );
      expect(replies[0].text).toBe(
        'Should we deliver to 12 Admiralty Way, Lekki again?',
      );
      expect(replies[0].payload).toEqual({
        kind: 'choices',
        data: {
          purpose: 'fulfillment',
          options: [
            { id: 'SAME', label: 'Yes, same address' },
            { id: 'NEW', label: 'New address' },
            { id: 'PICKUP', label: "I'll pick it up" },
          ],
        },
      });
    });

    it('reuses the last address on "same", and goes to the summary', async () => {
      stored = { ...returning };

      await flow.handle(
        conversationAt(ConversationState.COLLECTING_FULFILLMENT, returning),
        'Yes, same address',
      );

      expect(conversations.mergeContext).toHaveBeenCalledWith('c1', {
        profile: {
          fulfillmentType: 'DELIVERY',
          address: '12 Admiralty Way, Lekki',
        },
      });
      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.CONFIRMING_ORDER,
      );
    });

    it('asks for the new address on "new", and does not keep the old one', async () => {
      stored = { ...returning };

      const replies = await flow.handle(
        conversationAt(ConversationState.COLLECTING_FULFILLMENT, returning),
        'New address',
      );

      expect(conversations.mergeContext).toHaveBeenCalledWith('c1', {
        profile: { fulfillmentType: 'DELIVERY', address: undefined },
      });
      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_ADDRESS,
      );
      expect(replies[0].text).toBe(
        "What's the new address? House number, street and area.",
      );
    });

    it('reads a typed "no, a different one" as a new address, not a yes', async () => {
      await flow.handle(
        conversationAt(ConversationState.COLLECTING_FULFILLMENT, returning),
        'no, deliver to a different place',
      );

      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_ADDRESS,
      );
    });

    it('takes pickup, with no address at all', async () => {
      stored = { ...returning };

      await flow.handle(
        conversationAt(ConversationState.COLLECTING_FULFILLMENT, returning),
        "I'll pick it up",
      );

      expect(conversations.mergeContext).toHaveBeenCalledWith('c1', {
        profile: { fulfillmentType: 'PICKUP' },
      });
      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.CONFIRMING_ORDER,
      );
    });

    it.each(['not the same place', 'no', "don't deliver there"])(
      'never reads "%s" as the same address',
      async (answer) => {
        const replies = await flow.handle(
          conversationAt(ConversationState.COLLECTING_FULFILLMENT, returning),
          answer,
        );

        expect(conversations.setState).not.toHaveBeenCalled();
        expect(replies[0].text).toContain('12 Admiralty Way, Lekki');
      },
    );

    it('asks again rather than guessing an unclear answer', async () => {
      const replies = await flow.handle(
        conversationAt(ConversationState.COLLECTING_FULFILLMENT, returning),
        'hmm',
      );

      expect(conversations.setState).not.toHaveBeenCalled();
      expect(replies[0].text).toContain('12 Admiralty Way, Lekki');
    });
  });

  describe('an address never reused silently', () => {
    it('asks for the address even if one was typed into an abandoned checkout', async () => {
      // Typed last time, never paid for: no lastDeliveryAddress.
      stored = {
        profile: {
          name: 'Ada',
          phone: '+2348012345678',
          address: 'somewhere typed once',
        },
        receiptEmailSkipped: true,
      };

      const replies = await flow.handle(
        conversationAt(ConversationState.COLLECTING_FULFILLMENT, stored),
        'Deliver to me',
      );

      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_ADDRESS,
      );
      expect(replies[0].text).toBe(ASK_ADDRESS);
    });
  });

  describe('the receipt email', () => {
    it('is asked for after the phone number, with the card to enter it', async () => {
      stored = { profile: { name: 'Ada' } };

      const replies = await flow.handle(
        conversationAt(ConversationState.COLLECTING_PHONE),
        '0801 234 5678',
      );

      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_EMAIL,
      );
      expect(replies[0].text).toContain('receipt');
      expect(replies[0].payload).toEqual({ kind: 'email_capture', data: {} });
    });

    it('can be skipped, and the skip is remembered', async () => {
      await flow.handle(
        conversationAt(ConversationState.COLLECTING_EMAIL),
        'Skip for now',
      );

      expect(conversations.mergeContext).toHaveBeenCalledWith('c1', {
        receiptEmailSkipped: true,
      });
      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_FULFILLMENT,
      );
    });

    it('puts a typed email into the card rather than trusting it unverified', async () => {
      const replies = await flow.handle(
        conversationAt(ConversationState.COLLECTING_EMAIL),
        'my email is ada@example.com',
      );

      expect(replies[0].payload).toEqual({
        kind: 'email_capture',
        data: { email: 'ada@example.com' },
      });
      expect(conversations.setState).not.toHaveBeenCalled();
      expect(stored.profile?.email).toBeUndefined();
    });

    it('moves on by itself once the email is verified in the card', async () => {
      const replies = await flow.continueAfterSignIn(
        conversationAt(ConversationState.COLLECTING_EMAIL),
      );

      expect(conversations.setState).toHaveBeenCalledWith(
        'c1',
        ConversationState.COLLECTING_FULFILLMENT,
      );
      expect(replies[0].text).toContain('delivered');
    });

    it('leaves a conversation that was not at the email step alone', async () => {
      const replies = await flow.continueAfterSignIn(
        conversationAt(ConversationState.DISCOVERY),
      );

      expect(replies).toEqual([]);
      expect(conversations.setState).not.toHaveBeenCalled();
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

  describe('asking the question again, after the buyer asked one', () => {
    it('re-asks for the name without the "Lovely." it opened with', async () => {
      const replies = await flow.repeatQuestion(
        conversationAt(ConversationState.COLLECTING_NAME),
      );
      expect(replies[0].text).toBe('What name should I put on the order?');
    });

    it('re-asks for the address', async () => {
      conversations.findById.mockResolvedValue({
        id: 'c1',
        state: ConversationState.COLLECTING_ADDRESS,
        context: {},
      });

      const replies = await flow.repeatQuestion(
        conversationAt(ConversationState.COLLECTING_ADDRESS),
      );
      expect(replies[0].text).toBe(ASK_ADDRESS);
    });

    it('re-asks the area for the address already given, with the same buttons', async () => {
      conversations.findById.mockResolvedValue({
        id: 'c1',
        state: ConversationState.COLLECTING_ADDRESS,
        context: {
          addressDraft: {
            text: '12 Allen Avenue',
            stage: 'AREA',
            suggestedAreaId: 'a-yaba',
          },
        },
      });

      const replies = await flow.repeatQuestion(
        conversationAt(ConversationState.COLLECTING_ADDRESS),
      );
      expect(replies[0].text).toBe('Is 12 Allen Avenue in Yaba?');
      expect(replies[0].payload?.kind).toBe('choices');
    });

    it('re-asks for the landmark, Skip and all', async () => {
      conversations.findById.mockResolvedValue({
        id: 'c1',
        state: ConversationState.COLLECTING_ADDRESS,
        context: {
          addressDraft: { text: '12 Allen Avenue, Ikeja', stage: 'LANDMARK' },
        },
      });

      const replies = await flow.repeatQuestion(
        conversationAt(ConversationState.COLLECTING_ADDRESS),
      );
      expect(replies[0].text).toBe(
        'Any landmark or bus stop near it, to help the rider find you?',
      );
    });

    it('offers the extras again as a fresh card — the old one is retired once the buyer types', async () => {
      catalog.listAddOns.mockResolvedValue([
        {
          id: 'w1',
          name: 'Bottled Water',
          price: 300,
          vendorId: 'v1',
          vendorName: "Mama's Kitchen",
          imageUrl: null,
          isAddOn: true,
        },
      ]);
      conversations.findById.mockResolvedValue({
        id: 'c1',
        state: ConversationState.OFFERING_ADDONS,
        context: { pendingCart: CART },
      });

      const replies = await flow.repeatQuestion(
        conversationAt(ConversationState.OFFERING_ADDONS),
      );
      expect(replies[0].text).toBe(
        'Would you like anything to go with it? Pick below, or tap No, thanks.',
      );
      expect(replies[0].payload?.kind).toBe('addon_offer');
    });

    it('asks to go ahead again at the summary', async () => {
      conversations.findById.mockResolvedValue({
        id: 'c1',
        state: ConversationState.CONFIRMING_ORDER,
        context: {},
      });

      const replies = await flow.repeatQuestion(
        conversationAt(ConversationState.CONFIRMING_ORDER),
      );
      expect(replies[0].text).toBe('Shall I go ahead with the order above?');
    });

    it('records nothing and moves nothing', async () => {
      await flow.repeatQuestion(
        conversationAt(ConversationState.COLLECTING_PHONE),
      );

      expect(conversations.mergeContext).not.toHaveBeenCalled();
      expect(conversations.setState).not.toHaveBeenCalled();
    });
  });

  describe('taking the delivery address', () => {
    const at = (context: ConversationContext = {}) =>
      conversationAt(ConversationState.COLLECTING_ADDRESS, context);

    beforeEach(() => {
      stored = { pendingCart: CART, profile: { fulfillmentType: 'DELIVERY' } };
    });

    it('asks once for the house number and street when there is neither', async () => {
      const replies = await flow.handle(at(), 'Behind the big mosque, Yaba');

      expect(replies[0].text).toBe(
        'Could you add the house number and street, so the rider can find you?',
      );
      expect(stored.addressRetried).toBe(true);
    });

    it('takes it as given the second time — nobody is locked out', async () => {
      stored.addressRetried = true;

      const replies = await flow.handle(at(), 'Behind the big mosque, Yaba');

      expect(replies[0].text).toBe(
        'Any landmark or bus stop near it, to help the rider find you?',
      );
    });

    it.each([
      '12 Allen Avenue, Ikeja',
      'Plot 5, Admiralty Way, Ikeja',
      'Allen Avenue, Ikeja',
    ])(
      'accepts "%s" and asks for a landmark, with a Skip button',
      async (address) => {
        const replies = await flow.handle(at(), address);

        expect(stored.addressDraft).toEqual({
          text: address,
          stage: 'LANDMARK',
        });
        expect(replies[0].payload).toEqual({
          kind: 'choices',
          data: {
            purpose: 'landmark',
            options: [{ id: 'skip', label: 'Skip' }],
          },
        });
      },
    );

    it('adds the landmark to the address the rider reads', async () => {
      stored.addressDraft = {
        text: '12 Allen Avenue, Ikeja',
        stage: 'LANDMARK',
      };

      const replies = await flow.handle(at(), 'opposite Ikeja City Mall');

      expect(stored.profile?.address).toBe(
        '12 Allen Avenue, Ikeja (opposite Ikeja City Mall)',
      );
      expect(stored.addressDraft).toBeUndefined();
      expect(replies[replies.length - 1].payload?.kind).toBe('order_summary');
    });

    it('keeps the address as it was on Skip', async () => {
      stored.addressDraft = {
        text: '12 Allen Avenue, Ikeja',
        stage: 'LANDMARK',
      };

      await flow.handle(at(), 'Skip');

      expect(stored.profile?.address).toBe('12 Allen Avenue, Ikeja');
    });

    it('turns down an area we do not cover, naming the ones we do', async () => {
      const replies = await flow.handle(at(), '4 Lekki-Epe Expressway, Ajah');

      expect(replies[0].text).toBe(
        "We don't deliver to Ajah yet — right now we cover Ikeja and Yaba. Could you give an address in one of those?",
      );
      expect(stored.addressDraft).toBeUndefined();
      expect(stored.profile?.address).toBeUndefined();
    });

    it("turns down an area the cart's vendor does not deliver to", async () => {
      catalog.getVendorById.mockResolvedValue({
        id: 'v1',
        name: "Mama's Kitchen",
        areas: [YABA],
      });

      const replies = await flow.handle(at(), '12 Allen Avenue, Ikeja');

      expect(replies[0].text).toBe(
        'Mama\'s Kitchen doesn\'t deliver to Ikeja — they deliver to Yaba. Could you give an address there, or say "cancel" to change your order?',
      );
      expect(stored.profile?.address).toBeUndefined();
    });

    it('asks "Is that in Yaba?" when the address names no area but the chat knows one', async () => {
      conversations.findById.mockImplementation(() =>
        Promise.resolve({ id: 'c1', areaId: 'a-yaba', context: stored }),
      );

      const replies = await flow.handle(at(), '12 Herbert Macaulay Way');

      expect(replies[0].text).toBe('Is that in Yaba?');
      expect(replies[0].payload).toEqual({
        kind: 'choices',
        data: {
          purpose: 'area-confirm',
          options: [
            { id: 'yes', label: 'Yes, Yaba' },
            { id: 'no', label: 'No, a different area' },
          ],
        },
      });

      await flow.handle(at(), 'Yes, Yaba');

      expect(stored.addressDraft).toEqual({
        text: '12 Herbert Macaulay Way, Yaba',
        stage: 'LANDMARK',
      });
    });

    it('takes a plain "yes" to the suggested area', async () => {
      stored.addressDraft = {
        text: '12 Herbert Macaulay Way',
        stage: 'AREA',
        suggestedAreaId: 'a-yaba',
      };

      await flow.handle(at(), 'yes');

      expect(stored.addressDraft?.text).toBe('12 Herbert Macaulay Way, Yaba');
    });

    it('asks which area on "No, a different area"', async () => {
      stored.addressDraft = {
        text: '12 Allen Avenue',
        stage: 'AREA',
        suggestedAreaId: 'a-yaba',
      };

      const replies = await flow.handle(at(), 'No, a different area');

      expect(replies[0].text).toBe('Which area is it in?');

      await flow.handle(at(), 'Ikeja');
      expect(stored.addressDraft?.text).toBe('12 Allen Avenue, Ikeja');
    });

    it('asks which area when the chat knows none', async () => {
      const replies = await flow.handle(at(), '12 Allen Avenue');

      expect(replies[0].text).toBe('Which area is that in?');
    });

    it("says so when it doesn't recognise the area given", async () => {
      stored.addressDraft = { text: '12 Allen Avenue', stage: 'AREA' };

      const replies = await flow.handle(at(), 'Narnia');

      expect(replies[0].text).toBe(
        "I don't recognise that area. We deliver to Ikeja and Yaba — which is it in?",
      );
    });

    it('checks an area given separately like any other', async () => {
      stored.addressDraft = { text: '4 Lekki-Epe Expressway', stage: 'AREA' };

      const replies = await flow.handle(at(), 'Ajah');

      expect(replies[0].text).toMatch(/^We don't deliver to Ajah yet/);
    });

    it('starts every new checkout with a clean address', async () => {
      stored.addressDraft = { text: 'old', stage: 'LANDMARK' };
      stored.addressRetried = true;

      await flow.start(conversationAt(ConversationState.DISCOVERY), CART);

      expect(stored.addressDraft).toBeUndefined();
      expect(stored.addressRetried).toBeUndefined();
    });
  });

  describe('reading the order back', () => {
    it('quotes the delivery fee and total the buyer is about to be charged', async () => {
      stored = {
        profile: {
          name: 'Ada Obi',
          phone: '+2348012345678',
          fulfillmentType: 'DELIVERY',
        },
        pendingCart: CART,
        addressDraft: { text: '12 Allen Avenue, Ikeja', stage: 'LANDMARK' },
      };
      const replies = await flow.handle(
        conversationAt(ConversationState.COLLECTING_ADDRESS, stored),
        'Skip',
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

    it.each([
      [
        ConversationState.COLLECTING_ADDRESS,
        '12 Allen Avenue, opposite Ojuelegba bus stop',
      ],
      [
        ConversationState.COLLECTING_ADDRESS,
        'Stop 3, Lekki Phase 1, after the cancel gate',
      ],
      [ConversationState.COLLECTING_NAME, 'Never Mind Okafor'],
    ])(
      'reads a %s answer containing a cancel word as the answer: "%s"',
      async (state, answer) => {
        await flow.handle(conversationAt(state), answer);

        expect(conversations.setState).not.toHaveBeenCalledWith(
          'c1',
          ConversationState.DISCOVERY,
        );
        expect(conversations.mergeContext).toHaveBeenCalledWith(
          'c1',
          state === ConversationState.COLLECTING_ADDRESS
            ? {
                addressDraft: {
                  text: answer,
                  stage: 'AREA',
                  suggestedAreaId: undefined,
                },
              }
            : { profile: { name: answer } },
        );
      },
    );

    it.each([
      'cancel',
      'Stop please',
      'never mind.',
      'cancel the order',
      'add something else',
    ])(
      'still lets the buyer out at the address step with "%s"',
      async (answer) => {
        const replies = await flow.handle(
          conversationAt(ConversationState.COLLECTING_ADDRESS),
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
