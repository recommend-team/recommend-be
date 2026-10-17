import { BuyerOrderEmailsListener } from './buyer-order-emails.listener';
import { CheckoutPaidEvent } from '../../common/events/checkout-paid.event';
import { CheckoutStatusChangedEvent } from '../../common/events/checkout-status-changed.event';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';

const paid = (email: string | null) =>
  new CheckoutPaidEvent(
    'ck1',
    'REC-ABC123',
    'Ada Obi',
    '+2348012345678',
    email,
    'DELIVERY',
    '12 Herbert Macaulay Way',
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
          { name: 'Suya', quantity: 2, unitPrice: 3500, lineTotal: 7000 },
        ],
      },
    ],
    new Date(),
  );

const moved = (to: OrderStatus, code: string | null = 'KQ7MRT') =>
  new CheckoutStatusChangedEvent(
    'ck1',
    'REC-ABC123',
    'Ada Obi',
    '+2348012345678',
    FulfillmentType.DELIVERY,
    OrderStatus.READY,
    to,
    [{ name: 'Suya', quantity: 2 }],
    ['Mama Ngozi Kitchen'],
    code,
  );

describe('emails to the buyer', () => {
  let sendEmail: jest.Mock;
  let checkout: Record<string, unknown> | null;
  let listener: BuyerOrderEmailsListener;

  beforeEach(() => {
    sendEmail = jest.fn().mockResolvedValue(undefined);
    checkout = {
      id: 'ck1',
      buyerEmail: 'ada@example.com',
      rider: {
        firstName: 'Tunde',
        lastName: 'Bakare',
        phoneNumber: '+2348000009911',
      },
    };
    listener = new BuyerOrderEmailsListener(
      { findOne: jest.fn(() => Promise.resolve(checkout)) } as never,
      { sendEmail } as never,
      { get: jest.fn(() => undefined) } as never,
    );
  });

  it('sends a receipt when an order with an email is paid', async () => {
    await listener.onPaid(paid('ada@example.com'));

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ada@example.com',
        subject: expect.stringContaining('is paid') as unknown as string,
      }),
    );
  });

  it('sends nothing to a buyer who gave no email, or to the placeholder Paystack needs', async () => {
    await listener.onPaid(paid(null));
    await listener.onPaid(paid('2348012345678@buyers.recommend.ng'));

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends the delivery code when the order is dispatched', async () => {
    await listener.onStatusChanged(moved(OrderStatus.DISPATCHED));

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ada@example.com',
        subject: 'On its way — your delivery code is KQ7MRT',
      }),
    );
  });

  it('sends nothing for any other move', async () => {
    await listener.onStatusChanged(moved(OrderStatus.READY));
    await listener.onStatusChanged(moved(OrderStatus.COMPLETED));

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends nothing on a dispatch with no code to give', async () => {
    await listener.onStatusChanged(moved(OrderStatus.DISPATCHED, null));

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('never fails the payment or dispatch when the email cannot be sent', async () => {
    sendEmail.mockRejectedValue(new Error('Brevo down'));

    await expect(
      listener.onPaid(paid('ada@example.com')),
    ).resolves.toBeUndefined();
    await expect(
      listener.onStatusChanged(moved(OrderStatus.DISPATCHED)),
    ).resolves.toBeUndefined();
  });
});
