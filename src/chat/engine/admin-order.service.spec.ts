import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminOrderService } from './admin-order.service';
import { ConversationService } from '../conversation/conversation.service';
import { HandoverService } from './handover.service';
import { ORDERING_PORT } from '../ports/ordering.port';
import { CartChangedError } from '../adapters/local-ordering.adapter';
import type { Conversation } from '../conversation/entities/conversation.entity';

const ADMIN = 'admin-1';
const OTHER_ADMIN = 'admin-2';

const conversationWith = (over: Partial<Conversation> = {}): Conversation =>
  ({
    id: 'c1',
    buyerId: null,
    heldByAdminId: ADMIN,
    context: {
      profile: {
        name: 'Ada Obi',
        phone: '+2348012345678',
        fulfillmentType: 'DELIVERY',
        address: '12 Test Close, Ikeja',
      },
    },
    ...over,
  }) as unknown as Conversation;

const placed = {
  checkoutId: 'ck1',
  reference: 'REC-NEW',
  authorizationUrl: 'https://paystack/x',
  accessCode: 'ac_1',
  paystackPublicKey: 'pk_test',
  goodsTotal: 7000,
  deliveryFee: 1500,
  totalAmount: 8500,
};

const lines = [{ productId: 'p1', quantity: 2 }];

describe('AdminOrderService', () => {
  let service: AdminOrderService;
  let ordering: { placeCheckout: jest.Mock; listOrders: jest.Mock };
  let conversations: { findById: jest.Mock; mergeContext: jest.Mock };
  let handover: { send: jest.Mock };

  beforeEach(async () => {
    ordering = {
      placeCheckout: jest.fn().mockResolvedValue(placed),
      listOrders: jest.fn().mockResolvedValue([]),
    };
    conversations = {
      findById: jest.fn().mockResolvedValue(conversationWith()),
      mergeContext: jest.fn().mockResolvedValue(null),
    };
    handover = { send: jest.fn().mockResolvedValue({ text: 'sent' }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminOrderService,
        { provide: ORDERING_PORT, useValue: ordering },
        { provide: ConversationService, useValue: conversations },
        { provide: HandoverService, useValue: handover },
      ],
    }).compile();

    service = module.get(AdminOrderService);
  });

  /** The context patch the service wrote, which is where the regressions live. */
  const patch = (): Record<string, unknown> => {
    const calls = conversations.mergeContext.mock.calls as unknown[][];
    return (calls[0]?.[1] ?? {}) as Record<string, unknown>;
  };

  describe('placing the order', () => {
    it('records the admin against the checkout', async () => {
      await service.place('c1', ADMIN, { lines });

      expect(ordering.placeCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ createdByAdminId: ADMIN }),
      );
    });

    it('fills the buyer details the conversation already knows', async () => {
      await service.place('c1', ADMIN, { lines });

      expect(ordering.placeCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          buyerName: 'Ada Obi',
          buyerPhone: '+2348012345678',
          fulfillmentType: 'DELIVERY',
          deliveryAddress: '12 Test Close, Ikeja',
        }),
      );
    });

    it('prefers what the admin typed over what the thread remembers', async () => {
      await service.place('c1', ADMIN, {
        lines,
        buyerName: 'Ada Nwosu',
        deliveryAddress: '9 Other Street, Yaba',
      });

      expect(ordering.placeCheckout).toHaveBeenCalledWith(
        expect.objectContaining({
          buyerName: 'Ada Nwosu',
          deliveryAddress: '9 Other Street, Yaba',
        }),
      );
    });
  });

  describe('the conversation context', () => {
    // The regression that matters. `EngineService.completeOrder` refuses any reference
    // missing from this array, and the buyer's Orders tab reads only from it — so
    // forgetting to append leaves an order the customer can neither see nor confirm,
    // and confirming is what releases the vendor's money.
    it('appends the reference to the orders this conversation owns', async () => {
      conversations.findById.mockResolvedValue(
        conversationWith({
          context: {
            profile: { name: 'Ada Obi', phone: '+2348012345678' },
            orderReferences: ['REC-OLD'],
          },
        } as Partial<Conversation>),
      );

      await service.place('c1', ADMIN, { lines, fulfillmentType: 'PICKUP' });

      expect(patch().orderReferences).toEqual(['REC-OLD', 'REC-NEW']);
    });

    it('keeps the reference for the first order a conversation ever places', async () => {
      await service.place('c1', ADMIN, { lines });

      expect(patch().orderReferences).toEqual(['REC-NEW']);
    });

    it('marks the payment pending, so the buyer hears about this order', async () => {
      await service.place('c1', ADMIN, { lines });

      expect(patch()).toEqual(
        expect.objectContaining({
          pendingCheckoutId: 'ck1',
          pendingPaymentReference: 'REC-NEW',
        }),
      );
    });

    it('writes back what the admin typed, so a thread can still be found by phone', async () => {
      conversations.findById.mockResolvedValue(
        conversationWith({ context: {} } as Partial<Conversation>),
      );

      await service.place('c1', ADMIN, {
        lines,
        buyerName: 'Ada Obi',
        buyerPhone: '+2348012345678',
        fulfillmentType: 'PICKUP',
      });

      expect(patch().profile).toEqual(
        expect.objectContaining({
          name: 'Ada Obi',
          phone: '+2348012345678',
        }),
      );
    });

    it('never touches the conversation state', async () => {
      await service.place('c1', ADMIN, { lines });

      // Setting AWAITING_PAYMENT here would fight takeover: the assistant is already
      // silent, handback resets the state, and the payment listener sets DISCOVERY.
      expect(patch()).not.toHaveProperty('state');
    });
  });

  describe('sending the payment card', () => {
    /** The payload argument handover was asked to deliver. */
    const cardPayload = () => {
      const calls = handover.send.mock.calls as unknown[][];
      return calls[0]?.[3] as { kind: string; data: Record<string, unknown> };
    };

    it('sends the card into the thread without being asked', async () => {
      const result = await service.place('c1', ADMIN, { lines });

      expect(handover.send).toHaveBeenCalledTimes(1);
      expect(result.sent).toBe(true);
    });

    it('sends the inline card, not a bare link', async () => {
      // An admin-created buyer pays from inside the chat like everyone else. Dropping
      // the access code would leave them with a URL and a worse checkout.
      await service.place('c1', ADMIN, { lines });

      expect(cardPayload().kind).toBe('payment_link');
      expect(cardPayload().data).toEqual(
        expect.objectContaining({
          reference: 'REC-NEW',
          accessCode: 'ac_1',
          publicKey: 'pk_test',
          authorizationUrl: 'https://paystack/x',
          totalAmount: 8500,
        }),
      );
    });

    it('leaves the admin to send it when they ask to', async () => {
      const result = await service.place('c1', ADMIN, {
        lines,
        sendToBuyer: false,
      });

      expect(handover.send).not.toHaveBeenCalled();
      expect(result.sent).toBe(false);
    });

    it('keeps the order when the message cannot be delivered', async () => {
      // The checkout exists and the money is still collectable. Unwinding a real order
      // because a socket was down would be the worse outcome.
      handover.send.mockRejectedValue(new Error('socket gone'));

      const result = await service.place('c1', ADMIN, { lines });

      expect(result.reference).toBe('REC-NEW');
      expect(result.sent).toBe(false);
      expect(conversations.mergeContext).toHaveBeenCalled();
    });
  });

  describe('the latest order', () => {
    it('reads the newest reference the conversation owns', async () => {
      conversations.findById.mockResolvedValue(
        conversationWith({
          context: { orderReferences: ['REC-OLD', 'REC-NEWEST'] },
        } as Partial<Conversation>),
      );
      ordering.listOrders.mockResolvedValue([
        { reference: 'REC-NEWEST', status: 'PAID' },
      ]);

      const order = await service.latestOrder('c1');

      expect(ordering.listOrders).toHaveBeenCalledWith(['REC-NEWEST']);
      expect(order?.status).toBe('PAID');
    });

    it('is null for a conversation that has never ordered', async () => {
      conversations.findById.mockResolvedValue(
        conversationWith({ context: {} } as Partial<Conversation>),
      );

      expect(await service.latestOrder('c1')).toBeNull();
      expect(ordering.listOrders).not.toHaveBeenCalled();
    });
  });

  describe('what it refuses', () => {
    it('refuses a conversation this admin has not taken', async () => {
      conversations.findById.mockResolvedValue(
        conversationWith({ heldByAdminId: OTHER_ADMIN }),
      );

      await expect(service.place('c1', ADMIN, { lines })).rejects.toThrow(
        /take the conversation/i,
      );
      expect(ordering.placeCheckout).not.toHaveBeenCalled();
    });

    it('refuses a conversation nobody is holding', async () => {
      conversations.findById.mockResolvedValue(
        conversationWith({ heldByAdminId: null }),
      );

      await expect(service.place('c1', ADMIN, { lines })).rejects.toThrow(
        /take the conversation/i,
      );
    });

    it('refuses a second order while one is still waiting to be paid', async () => {
      conversations.findById.mockResolvedValue(
        conversationWith({
          context: {
            profile: { name: 'Ada Obi', phone: '+2348012345678' },
            pendingPaymentReference: 'REC-OLD',
          },
        } as Partial<Conversation>),
      );

      await expect(service.place('c1', ADMIN, { lines })).rejects.toThrow(
        /already has a payment waiting/i,
      );
      expect(ordering.placeCheckout).not.toHaveBeenCalled();
    });

    it('refuses a delivery with no address anyone knows', async () => {
      conversations.findById.mockResolvedValue(
        conversationWith({
          context: { profile: { name: 'Ada Obi', phone: '+2348012345678' } },
        } as Partial<Conversation>),
      );

      await expect(
        service.place('c1', ADMIN, { lines, fulfillmentType: 'DELIVERY' }),
      ).rejects.toThrow(/address is required/i);
    });

    it('refuses when neither the admin nor the thread knows who the buyer is', async () => {
      conversations.findById.mockResolvedValue(
        conversationWith({ context: {} } as Partial<Conversation>),
      );

      await expect(service.place('c1', ADMIN, { lines })).rejects.toThrow(
        /buyer name is required/i,
      );
    });

    it('refuses an empty basket', async () => {
      await expect(service.place('c1', ADMIN, { lines: [] })).rejects.toThrow(
        /at least one item/i,
      );
    });

    it('says nothing about a conversation that does not exist', async () => {
      conversations.findById.mockResolvedValue(null);

      await expect(service.place('c1', ADMIN, { lines })).rejects.toThrow(
        /not found/i,
      );
    });
  });

  it('turns a moved basket into a 409 the admin UI can explain', async () => {
    // The adapter throws a plain error so the buyer flow can phrase it as chat. An
    // admin is on an HTTP call and should get the storefront's 409, changes intact.
    ordering.placeCheckout.mockRejectedValue(
      new CartChangedError({
        code: 'CART_CHANGED',
        changes: [
          {
            productId: 'p1',
            productName: 'Jollof Rice',
            reason: 'VENDOR_CLOSED',
          },
        ],
      }),
    );

    const error: unknown = await service
      .place('c1', ADMIN, { lines })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'CART_CHANGED',
      changes: [expect.objectContaining({ reason: 'VENDOR_CLOSED' })],
    });
    expect(conversations.mergeContext).not.toHaveBeenCalled();
  });
});
