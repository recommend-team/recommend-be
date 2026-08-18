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
      ],
    }).compile();

    listener = module.get(OrderStatusListener);
  });

  const sentText = () =>
    (conversations.recordOutbound.mock.calls[0]?.[0] as { text: string })?.text;

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
