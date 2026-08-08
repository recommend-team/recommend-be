import { Test, TestingModule } from '@nestjs/testing';
import { PaymentConfirmationListener } from './payment-confirmation.listener';
import { ConversationService } from '../conversation/conversation.service';
import { ChannelRegistry } from '../transport/channel.registry';
import { ChatChannel } from '../enums/chat.enums';
import { CheckoutPaidEvent } from '../../common/events/checkout-paid.event';

const event = (over: Partial<CheckoutPaidEvent> = {}) =>
  Object.assign(
    new CheckoutPaidEvent(
      'checkout-1',
      'REC-ABC123',
      'Ada Obi',
      '+2348012345678',
      null,
      'DELIVERY',
      '12 Herbert Macaulay Way, Yaba',
      10500,
      1500,
      12000,
      [
        {
          orderId: 'o1',
          vendorId: 'v1',
          vendorName: 'Tasty Pot Ikeja',
          subtotal: 6000,
          vendorAmount: 4800,
          items: [
            {
              name: 'Jollof Rice',
              quantity: 2,
              unitPrice: 3000,
              lineTotal: 6000,
            },
          ],
        },
      ],
      new Date(),
    ),
    over,
  );

describe('PaymentConfirmationListener', () => {
  let listener: PaymentConfirmationListener;
  let conversations: {
    findForCheckout: jest.Mock;
    recordOutbound: jest.Mock;
    mergeContext: jest.Mock;
  };
  let registry: { send: jest.Mock };

  beforeEach(async () => {
    conversations = {
      findForCheckout: jest.fn().mockResolvedValue({
        id: 'c1',
        channel: ChatChannel.PWA,
        channelAddress: 'session-1',
      }),
      recordOutbound: jest.fn().mockResolvedValue({
        id: 'msg-1',
        createdAt: new Date(),
        payload: { kind: 'order_summary', data: {} },
      }),
      mergeContext: jest.fn(),
    };
    registry = { send: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentConfirmationListener,
        { provide: ConversationService, useValue: conversations },
        { provide: ChannelRegistry, useValue: registry },
      ],
    }).compile();

    listener = module.get<PaymentConfirmationListener>(
      PaymentConfirmationListener,
    );
  });

  it('posts the confirmation into the buyer’s existing thread', async () => {
    await listener.onCheckoutPaid(event());

    expect(conversations.recordOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'c1' }),
    );
    expect(registry.send).toHaveBeenCalledWith(
      ChatChannel.PWA,
      'session-1',
      expect.objectContaining({ messageId: 'msg-1' }),
    );
  });

  it('persists before sending, so a closed tab still finds it in history', async () => {
    const order: string[] = [];
    conversations.recordOutbound.mockImplementation(() => {
      order.push('persist');
      return Promise.resolve({
        id: 'msg-1',
        createdAt: new Date(),
        payload: null,
      });
    });
    registry.send.mockImplementation(() => {
      order.push('send');
      return Promise.resolve(null);
    });

    await listener.onCheckoutPaid(event());

    expect(order).toEqual(['persist', 'send']);
  });

  it('names the reference so the buyer can quote it', async () => {
    await listener.onCheckoutPaid(event());

    const message = (
      conversations.recordOutbound.mock.calls as [Record<string, unknown>][]
    )[0][0] as unknown as {
      text: string;
    };
    expect(message.text).toContain('REC-ABC123');
    expect(message.text).toContain('Payment confirmed');
  });

  it('attaches an order_summary payload with the real totals', async () => {
    await listener.onCheckoutPaid(event());

    const message = (
      conversations.recordOutbound.mock.calls as [Record<string, unknown>][]
    )[0][0] as unknown as {
      payload: { kind: string; data: Record<string, unknown> };
    };
    expect(message.payload.kind).toBe('order_summary');
    expect(message.payload.data).toMatchObject({
      reference: 'REC-ABC123',
      totalAmount: 12000,
      deliveryFee: 1500,
      status: 'PAID',
    });
  });

  it('mentions delivery when there is an address', async () => {
    await listener.onCheckoutPaid(event());
    const message = (
      conversations.recordOutbound.mock.calls as [Record<string, unknown>][]
    )[0][0] as unknown as {
      text: string;
    };
    expect(message.text).toContain('12 Herbert Macaulay Way');
  });

  it('says pickup instead when there is no delivery', async () => {
    await listener.onCheckoutPaid(
      event({ fulfillmentType: 'PICKUP', deliveryAddress: null }),
    );
    const message = (
      conversations.recordOutbound.mock.calls as [Record<string, unknown>][]
    )[0][0] as unknown as {
      text: string;
    };
    expect(message.text.toLowerCase()).toContain('pickup');
  });

  it('stays quiet for a storefront checkout with no conversation', async () => {
    conversations.findForCheckout.mockResolvedValue(null);

    await listener.onCheckoutPaid(event());

    expect(conversations.recordOutbound).not.toHaveBeenCalled();
    expect(registry.send).not.toHaveBeenCalled();
  });

  it('clears the pending marker so a later checkout is not confused with this one', async () => {
    await listener.onCheckoutPaid(event());

    expect(conversations.mergeContext).toHaveBeenCalledWith('c1', {
      pendingPaymentReference: undefined,
      pendingCheckoutId: undefined,
    });
  });

  it('swallows its own failures — the webhook must not be retried', async () => {
    conversations.recordOutbound.mockRejectedValue(new Error('db down'));

    await expect(listener.onCheckoutPaid(event())).resolves.toBeUndefined();
  });
});
