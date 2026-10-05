import { BuyerPushService } from './buyer-push.service';
import { Test, TestingModule } from '@nestjs/testing';
import { OrderStatusListener } from './order-status.listener';
import { AppreciationService } from './appreciation.service';
import { ConversationService } from '../conversation/conversation.service';
import { ChannelRegistry } from '../transport/channel.registry';
import { ChatChannel } from '../enums/chat.enums';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';
import { CheckoutStatusChangedEvent } from '../../common/events/checkout-status-changed.event';

const event = (
  to: OrderStatus,
  fulfillmentType: FulfillmentType = FulfillmentType.DELIVERY,
) =>
  new CheckoutStatusChangedEvent(
    'ck1',
    'REC-AAA',
    'Ada Obi',
    '+2348012345678',
    fulfillmentType,
    OrderStatus.PAID,
    to,
    [{ name: 'Jollof Rice', quantity: 2 }],
    ['Tasty Pot Ikeja'],
    to === OrderStatus.DISPATCHED ? 'KDPXRM' : null,
  );

const buyerPush = { notify: jest.fn() };
beforeEach(() => buyerPush.notify.mockClear());

describe('OrderStatusListener', () => {
  let listener: OrderStatusListener;
  let conversations: { findForCheckout: jest.Mock; recordOutbound: jest.Mock };
  let registry: { send: jest.Mock };
  let appreciation: { write: jest.Mock };

  beforeEach(async () => {
    conversations = {
      findForCheckout: jest.fn().mockResolvedValue({
        id: 'c1',
        channel: ChatChannel.PWA,
        channelAddress: 'session-1',
      }),
      recordOutbound: jest
        .fn()
        .mockResolvedValue({ id: 'm1', createdAt: new Date() }),
    };
    registry = { send: jest.fn().mockResolvedValue(null) };
    appreciation = { write: jest.fn().mockResolvedValue('Thank you, Ada!') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderStatusListener,
        { provide: ConversationService, useValue: conversations },
        { provide: ChannelRegistry, useValue: registry },
        { provide: AppreciationService, useValue: appreciation },
        { provide: BuyerPushService, useValue: buyerPush },
      ],
    }).compile();

    listener = module.get(OrderStatusListener);
  });

  const sentText = () => {
    // `mock.calls` is any[][]; naming the shape once keeps the indexing below typed.
    const calls = conversations.recordOutbound.mock.calls as [
      { text: string },
    ][];
    return calls[0]?.[0]?.text;
  };

  it('says nothing when a delivery order becomes ready', async () => {
    // READY on a delivery is an internal handoff signal. The rider has not collected
    // anything yet, so there is nothing true to tell the buyer.
    await listener.onStatusChanged(event(OrderStatus.READY));

    expect(conversations.recordOutbound).not.toHaveBeenCalled();
    expect(registry.send).not.toHaveBeenCalled();
  });

  it('tells a pickup buyer to come and collect', async () => {
    // The same status, the opposite meaning: this is their cue to leave the house, and
    // the only message a pickup order ever produces before completion.
    await listener.onStatusChanged(
      event(OrderStatus.READY, FulfillmentType.PICKUP),
    );

    expect(sentText()).toMatch(/ready for collection/i);
  });

  describe('where and how to collect', () => {
    const pickup = (
      points: { vendorName: string | null; address: string | null }[],
      code: string | null = 'QWERTY',
    ) =>
      new CheckoutStatusChangedEvent(
        'ck1',
        'REC-AAA',
        'Ada Obi',
        '+2348012345678',
        FulfillmentType.PICKUP,
        OrderStatus.PAID,
        OrderStatus.READY,
        [{ name: 'Jollof Rice', quantity: 2 }],
        points.map((p) => p.vendorName ?? ''),
        code,
        points,
      );

    it('says where the order is, and the code to show', async () => {
      // Before, a pickup buyer was told their order was ready and not where.
      await listener.onStatusChanged(
        pickup([
          {
            vendorName: 'Mama Put Kitchen',
            address: '14 Herbert Macaulay Way, Yaba',
          },
        ]),
      );

      expect(sentText()).toBe(
        'Your order is ready for collection at Mama Put Kitchen, 14 Herbert Macaulay Way, Yaba. ' +
          'Show the code QWERTY when you collect.',
      );
    });

    it('names every vendor when the basket spans several', async () => {
      await listener.onStatusChanged(
        pickup([
          {
            vendorName: 'Mama Put Kitchen',
            address: '14 Herbert Macaulay Way, Yaba',
          },
          { vendorName: 'GadgetHub Ikeja', address: '22 Otigba Street, Ikeja' },
        ]),
      );

      expect(sentText()).toBe(
        'Your order is ready for collection from Mama Put Kitchen, 14 Herbert Macaulay Way, Yaba ' +
          'and GadgetHub Ikeja, 22 Otigba Street, Ikeja. Show the code QWERTY when you collect at each.',
      );
    });

    it('still names a vendor who never gave an address', async () => {
      await listener.onStatusChanged(
        pickup([{ vendorName: 'Mama Put Kitchen', address: null }]),
      );

      expect(sentText()).toBe(
        'Your order is ready for collection at Mama Put Kitchen. Show the code QWERTY when you collect.',
      );
    });

    it('pushes the same words, so the notification alone is enough to go and collect', async () => {
      await listener.onStatusChanged(
        pickup([
          {
            vendorName: 'Mama Put Kitchen',
            address: '14 Herbert Macaulay Way, Yaba',
          },
        ]),
      );

      expect(buyerPush.notify).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ body: sentText(), type: 'ORDER_READY' }),
        expect.anything(),
      );
    });
  });

  it('sends the one message a delivery buyer gets', async () => {
    await listener.onStatusChanged(event(OrderStatus.DISPATCHED));

    expect(sentText()).toMatch(/on its way/i);
    expect(registry.send).toHaveBeenCalledWith(
      ChatChannel.PWA,
      'session-1',
      expect.objectContaining({ messageId: 'm1' }),
    );
  });

  it('gives the buyer their delivery code in the same message', async () => {
    // One message, not two: the code and the reason it matters arrive together, and the
    // buyer's thread is pushed up the screen once.
    await listener.onStatusChanged(event(OrderStatus.DISPATCHED));

    expect(sentText()).toContain('KDPXRM');
    expect(sentText()).toMatch(/rider/i);
  });

  it('still announces a dispatch that carries no code', async () => {
    // An admin forcing the status straight to DISPATCHED mints nothing. The buyer is
    // told their order is coming and is not shown the word "undefined".
    const forced = new CheckoutStatusChangedEvent(
      'ck1',
      'REC-AAA',
      'Ada Obi',
      '+2348012345678',
      FulfillmentType.DELIVERY,
      OrderStatus.PAID,
      OrderStatus.DISPATCHED,
      [{ name: 'Jollof Rice', quantity: 2 }],
      ['Tasty Pot Ikeja'],
      null,
    );

    await listener.onStatusChanged(forced);

    expect(sentText()).toBe('Your order is on its way.');
  });

  describe('notifying a buyer who is away', () => {
    it('pushes "ready for collection" to a pickup buyer', async () => {
      await listener.onStatusChanged(
        event(OrderStatus.READY, FulfillmentType.PICKUP),
      );

      expect(buyerPush.notify).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({
          type: 'ORDER_READY',
          tag: 'order:REC-AAA',
          url: '/',
        }),
        { ttlSeconds: 21600 },
      );
    });

    it('pushes the dispatch urgently, with the delivery code in it', async () => {
      await listener.onStatusChanged(event(OrderStatus.DISPATCHED));

      expect(buyerPush.notify).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({
          type: 'ORDER_DISPATCHED',
          body: expect.stringContaining('KDPXRM') as unknown as string,
        }),
        { urgency: 'high', ttlSeconds: 21600 },
      );
    });

    it('does not push the thank-you — the buyer just confirmed receipt in the app', async () => {
      await listener.onStatusChanged(event(OrderStatus.COMPLETED));

      expect(buyerPush.notify).not.toHaveBeenCalled();
    });

    it('does not push what it does not tell the buyer at all', async () => {
      await listener.onStatusChanged(event(OrderStatus.READY));

      expect(buyerPush.notify).not.toHaveBeenCalled();
    });
  });

  it('has the assistant write the thank-you, and passes it the order', async () => {
    await listener.onStatusChanged(event(OrderStatus.COMPLETED));

    expect(appreciation.write).toHaveBeenCalledWith({
      buyerName: 'Ada Obi',
      items: [{ name: 'Jollof Rice', quantity: 2 }],
      vendorNames: ['Tasty Pot Ikeja'],
    });
    expect(sentText()).toBe('Thank you, Ada!');
  });

  it('stays quiet about every other transition', async () => {
    for (const status of [
      OrderStatus.PAID,
      OrderStatus.PROCESSING,
      OrderStatus.CANCELLED,
      OrderStatus.REFUNDED,
    ]) {
      await listener.onStatusChanged(event(status));
    }

    expect(conversations.recordOutbound).not.toHaveBeenCalled();
  });

  it('does not look for a conversation it has nothing to say to', async () => {
    // A pointless query on every vendor tapping ready, across every order.
    await listener.onStatusChanged(event(OrderStatus.READY));

    expect(conversations.findForCheckout).not.toHaveBeenCalled();
  });

  it('shrugs off an order placed outside the chat', async () => {
    conversations.findForCheckout.mockResolvedValue(null);

    await expect(
      listener.onStatusChanged(event(OrderStatus.DISPATCHED)),
    ).resolves.toBeUndefined();
    expect(registry.send).not.toHaveBeenCalled();
  });

  it('never lets a messaging failure unwind a delivery that happened', async () => {
    conversations.recordOutbound.mockRejectedValue(new Error('db down'));

    await expect(
      listener.onStatusChanged(event(OrderStatus.DISPATCHED)),
    ).resolves.toBeUndefined();
  });
});
