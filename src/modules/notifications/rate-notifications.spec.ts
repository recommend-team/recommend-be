import { NotificationsService } from './notifications.service';
import {
  NotificationType,
  type Notification,
} from './entities/notification.entity';
import type { PushPayload } from './push.service';
import { CommissionRateRaisedEvent } from '../../common/events/categories.events';

describe('telling a vendor their rate went up', () => {
  let feed: Partial<Notification>[];
  let push: { sendToUser: jest.Mock };
  let email: { sendEmail: jest.Mock };
  let users: { findOne: jest.Mock };
  let service: NotificationsService;

  beforeEach(() => {
    feed = [];
    push = {
      sendToUser: jest.fn<Promise<number>, [string, PushPayload]>(() =>
        Promise.resolve(1),
      ),
    };
    email = { sendEmail: jest.fn().mockResolvedValue(undefined) };
    users = {
      findOne: jest.fn().mockResolvedValue({
        id: 'v1',
        email: 'ada@shop.ng',
        firstName: 'Ada',
      }),
    };
    service = new NotificationsService(
      {
        create: (row: Partial<Notification>) => row,
        save: (row: Partial<Notification>) => {
          feed.push(row);
          return Promise.resolve({ ...row, id: 'n1' });
        },
      } as never,
      users as never,
      push as never,
      email as never,
    );
  });

  const rise = new CommissionRateRaisedEvent('v1', 20, 25);

  it('says the new rate, the old one, and that past orders are safe', async () => {
    await service.onCommissionRateRaised(rise);

    expect(feed[0]).toMatchObject({
      userId: 'v1',
      type: NotificationType.COMMISSION_RATE_RAISED,
      title: "Recommend's fee is now 25%",
      data: { previousPercent: 20, newPercent: 25 },
    });
    expect(feed[0].body).toBe(
      'From your next order, Recommend keeps 25% of each sale (it was 20%). ' +
        'Orders already placed are not affected.',
    );
  });

  it('pushes it to their phone and emails them', async () => {
    await service.onCommissionRateRaised(rise);

    expect(push.sendToUser).toHaveBeenCalledWith(
      'v1',
      expect.objectContaining({ title: "Recommend's fee is now 25%" }),
    );
    expect(email.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ada@shop.ng',
        subject: "Recommend's fee is now 25%",
      }),
    );
  });

  it('still notifies in the app when email is down', async () => {
    email.sendEmail.mockRejectedValue(new Error('Brevo down'));

    await expect(service.onCommissionRateRaised(rise)).resolves.toBeUndefined();
    expect(feed).toHaveLength(1);
  });
});
