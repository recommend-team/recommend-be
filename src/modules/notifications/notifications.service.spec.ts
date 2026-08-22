import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { Notification, NotificationType } from './entities/notification.entity';
import { PushService } from './push.service';
import { EmailService } from '../../common/services/email.service';
import { User } from '../auth/entities/auth.entity';
import {
  CheckoutPaidEvent,
  CheckoutPaidVendorOrder,
} from '../../common/events/checkout-paid.event';

const vendorOrder = (
  over: Partial<CheckoutPaidVendorOrder> = {},
): CheckoutPaidVendorOrder => ({
  orderId: 'o1',
  vendorId: 'v1',
  vendorName: 'Tasty Pot Ikeja',
  subtotal: 6000,
  vendorAmount: 4800,
  items: [
    { name: 'Jollof Rice', quantity: 2, unitPrice: 3000, lineTotal: 6000 },
  ],
  ...over,
});

const paidEvent = (orders: CheckoutPaidVendorOrder[]) =>
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
    orders,
    new Date(),
  );

describe('NotificationsService', () => {
  let service: NotificationsService;
  let notifications: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findAndCount: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
  };
  let users: { findOne: jest.Mock };
  let push: { sendToUser: jest.Mock };
  let email: { sendEmail: jest.Mock };

  beforeEach(async () => {
    notifications = {
      create: jest.fn((input: unknown) => input),
      save: jest.fn((input: Record<string, unknown>) =>
        Promise.resolve({ id: 'n1', ...input }),
      ),
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ affected: 3 }),
    };
    users = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'v1', email: 'vendor@example.com' }),
    };
    push = { sendToUser: jest.fn().mockResolvedValue(1) };
    email = { sendEmail: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: getRepositoryToken(Notification), useValue: notifications },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: PushService, useValue: push },
        { provide: EmailService, useValue: email },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  describe('on a paid checkout', () => {
    it('notifies every vendor in the basket', async () => {
      await service.onCheckoutPaid(
        paidEvent([
          vendorOrder({ vendorId: 'v1' }),
          vendorOrder({ orderId: 'o2', vendorId: 'v2' }),
        ]),
      );

      expect(notifications.save).toHaveBeenCalledTimes(2);
      expect(push.sendToUser).toHaveBeenCalledTimes(2);
    });

    it('tells each vendor only about their own items and payout', async () => {
      await service.onCheckoutPaid(
        paidEvent([
          vendorOrder({
            vendorId: 'v1',
            vendorAmount: 4800,
            items: [
              {
                name: 'Jollof Rice',
                quantity: 2,
                unitPrice: 3000,
                lineTotal: 6000,
              },
            ],
          }),
        ]),
      );

      const written = (
        notifications.save.mock.calls as [Record<string, unknown>][]
      )[0][0] as unknown as {
        body: string;
        data: Record<string, unknown>;
      };
      expect(written.body).toContain('2× Jollof Rice');
      expect(written.body).toContain('4,800');
      // Never the basket total — that includes another restaurant's food.
      expect(written.body).not.toContain('12,000');
      expect(written.data.vendorAmount).toBe(4800);
    });

    it('writes the feed entry before attempting delivery', async () => {
      const order: string[] = [];
      notifications.save.mockImplementation(() => {
        order.push('feed');
        return Promise.resolve({ id: 'n1' });
      });
      push.sendToUser.mockImplementation(() => {
        order.push('push');
        return Promise.resolve(1);
      });

      await service.onCheckoutPaid(paidEvent([vendorOrder()]));

      expect(order[0]).toBe('feed');
    });

    it('still notifies the second vendor when the first one throws', async () => {
      notifications.save
        .mockRejectedValueOnce(new Error('db blip'))
        .mockResolvedValue({ id: 'n2' });

      await expect(
        service.onCheckoutPaid(
          paidEvent([
            vendorOrder({ vendorId: 'v1' }),
            vendorOrder({ orderId: 'o2', vendorId: 'v2' }),
          ]),
        ),
      ).resolves.toBeUndefined();

      expect(notifications.save).toHaveBeenCalledTimes(2);
    });

    it('survives push and email both failing', async () => {
      push.sendToUser.mockRejectedValue(new Error('push gone'));
      email.sendEmail.mockRejectedValue(new Error('brevo down'));

      await expect(
        service.onCheckoutPaid(paidEvent([vendorOrder()])),
      ).resolves.toBeUndefined();

      // The durable record still exists, which is the point.
      expect(notifications.save).toHaveBeenCalled();
    });

    it('does not email a synthetic buyer address', async () => {
      users.findOne.mockResolvedValue({
        id: 'v1',
        email: '2348012345678@buyers.recommend.ng',
      });

      await service.onCheckoutPaid(paidEvent([vendorOrder()]));

      expect(email.sendEmail).not.toHaveBeenCalled();
    });

    it('includes the reference and address in the email', async () => {
      await service.onCheckoutPaid(paidEvent([vendorOrder()]));

      const sent = (
        email.sendEmail.mock.calls as [Record<string, unknown>][]
      )[0][0] as unknown as {
        subject: string;
        text: string;
      };
      expect(sent.subject).toContain('REC-ABC123');
      expect(sent.text).toContain('12 Herbert Macaulay Way');
    });
  });

  describe('feed', () => {
    it('scopes mark-read to the owner', async () => {
      notifications.findOne.mockResolvedValue(null);

      await expect(service.markRead('someone-else', 'n1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('does not re-stamp an already-read notification', async () => {
      const readAt = new Date('2026-01-01');
      notifications.findOne.mockResolvedValue({ id: 'n1', readAt });

      const result = await service.markRead('u1', 'n1');

      expect(result.readAt).toBe(readAt);
      expect(notifications.save).not.toHaveBeenCalled();
    });

    it('reports how many were cleared by mark-all-read', async () => {
      await expect(service.markAllRead('u1')).resolves.toEqual({ updated: 3 });
    });

    it('creates unread notifications by default', async () => {
      await service.create({
        userId: 'u1',
        type: NotificationType.KYC_APPROVED,
        title: 'Approved',
        body: 'You are approved',
      });

      expect(notifications.save).toHaveBeenCalledWith(
        expect.objectContaining({ readAt: null }),
      );
    });
  });
});
