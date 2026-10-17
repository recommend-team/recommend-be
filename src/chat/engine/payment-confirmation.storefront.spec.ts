import { PaymentConfirmationListener } from './payment-confirmation.listener';
import { ChatChannel } from '../enums/chat.enums';
import { CheckoutPaidEvent } from '../../common/events/checkout-paid.event';
import { CheckoutSource } from '../../common/enums/checkout-source.enum';

const paid = (over: Partial<CheckoutPaidEvent> = {}) =>
  Object.assign(
    new CheckoutPaidEvent(
      'checkout-1',
      'REC-STORE1',
      'Ada Obi',
      '+2348012345678',
      'ada@example.com',
      'DELIVERY',
      '12 Herbert Macaulay Way, Yaba',
      7000,
      1500,
      8500,
      [
        {
          orderId: 'o1',
          vendorId: 'v1',
          vendorName: 'Mama Ngozi Kitchen',
          subtotal: 7000,
          vendorAmount: 5600,
          items: [
            {
              name: 'Suya Platter',
              quantity: 2,
              unitPrice: 3500,
              lineTotal: 7000,
            },
          ],
        },
      ],
      new Date(),
      CheckoutSource.STOREFRONT,
    ),
    over,
  );

describe('a storefront order reaching the buyer’s chat', () => {
  let conversations: {
    findForCheckout: jest.Mock;
    recordOutbound: jest.Mock;
    mergeContext: jest.Mock;
    setState: jest.Mock;
  };
  let accounts: { chatForEmail: jest.Mock };
  let listener: PaymentConfirmationListener;
  const emailChat = {
    id: 'email-chat',
    channel: ChatChannel.PWA,
    channelAddress: 'account:acc-1',
    context: { orderReferences: ['REC-OLD'], profile: { name: 'Ada' } },
  };

  beforeEach(() => {
    conversations = {
      findForCheckout: jest.fn().mockResolvedValue({
        id: 'phone-chat',
        channel: ChatChannel.PWA,
        channelAddress: 'session-9',
      }),
      recordOutbound: jest.fn().mockResolvedValue({
        id: 'm1',
        createdAt: new Date(),
        payload: { kind: 'order_summary', data: {} },
      }),
      mergeContext: jest.fn((id: string) =>
        Promise.resolve({ ...emailChat, id }),
      ),
      setState: jest.fn(),
    };
    accounts = { chatForEmail: jest.fn().mockResolvedValue(emailChat) };
    listener = new PaymentConfirmationListener(
      conversations as never,
      { send: jest.fn() } as never,
      { notify: jest.fn() } as never,
      accounts as never,
    );
  });

  it('goes into the chat for the email it was paid with — not one guessed by phone', async () => {
    await listener.onCheckoutPaid(paid());

    expect(accounts.chatForEmail).toHaveBeenCalledWith('ada@example.com', {
      name: 'Ada Obi',
      phone: '+2348012345678',
    });
    expect(conversations.findForCheckout).not.toHaveBeenCalled();
    expect(conversations.recordOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'email-chat' }),
    );
  });

  it('is added to the orders that chat holds, so the Orders tab and every update find it', async () => {
    await listener.onCheckoutPaid(paid());

    expect(conversations.mergeContext).toHaveBeenCalledWith(
      'email-chat',
      expect.objectContaining({ orderReferences: ['REC-OLD', 'REC-STORE1'] }),
    );
  });

  it('fills in what the chat does not know about the buyer, without overwriting it', async () => {
    await listener.onCheckoutPaid(paid());

    expect(conversations.mergeContext).toHaveBeenCalledWith(
      'email-chat',
      expect.objectContaining({
        profile: {
          name: 'Ada',
          phone: '+2348012345678',
          email: 'ada@example.com',
        },
      }),
    );
  });

  it('is not added twice if the payment is confirmed twice', async () => {
    accounts.chatForEmail.mockResolvedValue({
      ...emailChat,
      context: { orderReferences: ['REC-STORE1'] },
    });

    await listener.onCheckoutPaid(paid());

    expect(conversations.mergeContext).toHaveBeenCalledWith(
      'email-chat',
      expect.objectContaining({ orderReferences: ['REC-STORE1'] }),
    );
  });

  it('leaves a chat order in the chat it was placed from', async () => {
    await listener.onCheckoutPaid(paid({ source: CheckoutSource.CHAT }));

    expect(accounts.chatForEmail).not.toHaveBeenCalled();
    expect(conversations.findForCheckout).toHaveBeenCalled();
  });
});
