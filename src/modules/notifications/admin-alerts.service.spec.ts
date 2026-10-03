import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminAlertsService } from './admin-alerts.service';
import { PushService } from './push.service';
import { User } from '../auth/entities/auth.entity';
import { Role } from '../../common/enums/roles.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';
import {
  ADMIN_ALERT_EVENT,
  AdminAlertEvent,
  ConversationHandedOverEvent,
  ConversationNeedsAttentionEvent,
  HeldConversationMessageEvent,
} from '../../common/events/admin-alert.events';
import { CheckoutPaidEvent } from '../../common/events/checkout-paid.event';
import { WithdrawalFailedEvent } from '../../common/events/wallet.events';

const admin = (id: string, over: Partial<User> = {}): User =>
  Object.assign(new User(), {
    id,
    role: Role.ADMIN,
    status: SellerStatus.APPROVED,
    isEmailVerified: true,
    ...over,
  });

describe('AdminAlertsService', () => {
  let service: AdminAlertsService;
  let emitted: AdminAlertEvent[];
  let push: { sendToUser: jest.Mock };
  let users: { find: jest.Mock; findOne: jest.Mock };

  beforeEach(async () => {
    emitted = [];
    push = { sendToUser: jest.fn().mockResolvedValue(1) };
    users = {
      find: jest
        .fn()
        .mockResolvedValue([
          admin('a1'),
          admin('a2', { role: Role.SUPER_ADMIN }),
          admin('a3', { status: SellerStatus.SUSPENDED }),
        ]),
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 'v1', businessName: 'Mama Put' }),
    };

    const module = await Test.createTestingModule({
      providers: [
        AdminAlertsService,
        { provide: getRepositoryToken(User), useValue: users },
        { provide: PushService, useValue: push },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn((name: string, alert: AdminAlertEvent) => {
              if (name === ADMIN_ALERT_EVENT) emitted.push(alert);
            }),
          },
        },
      ],
    }).compile();

    service = module.get(AdminAlertsService);
  });

  const pushedTo = () =>
    (push.sendToUser.mock.calls as [string][]).map(([adminId]) => adminId);

  describe('a conversation the assistant flagged', () => {
    beforeEach(() =>
      service.onNeedsAttention(
        new ConversationNeedsAttentionEvent(
          'c1',
          'Nothing matched what they asked for',
          'Ada',
        ),
      ),
    );

    it('alerts every active admin, and not a suspended one', () => {
      expect(emitted[0]).toMatchObject({
        kind: 'CONVERSATION_FLAGGED',
        adminId: null,
        url: '/admin/conversations/c1',
      });
      expect(pushedTo()).toEqual(['a1', 'a2']);
    });

    it('says who and why', () => {
      expect(emitted[0].body).toBe(
        'Ada — nothing matched what they asked for.',
      );
    });

    it('pushes urgently, with the same id the socket carried', () => {
      expect(push.sendToUser).toHaveBeenCalledWith(
        'a1',
        expect.objectContaining({
          type: 'CONVERSATION_FLAGGED',
          tag: 'conversation:c1',
          data: { alertId: emitted[0].id },
        }),
        { urgency: 'high', ttlSeconds: 900 },
      );
    });
  });

  describe('a buyer the assistant handed over', () => {
    beforeEach(() =>
      service.onHandedOver(
        new ConversationHandedOverEvent('c1', 'Wants a refund', 'Ada', 5),
      ),
    );

    it('alerts every active admin, saying how long they have', () => {
      expect(emitted[0]).toMatchObject({
        kind: 'CONVERSATION_HANDED_OVER',
        title: 'Ada is waiting for you',
        body: 'Wants a refund. The assistant answers again in 5 min if nobody takes it.',
        url: '/admin/conversations/c1',
        adminId: null,
      });
      expect(pushedTo()).toEqual(['a1', 'a2']);
    });

    it('expires the push with the wait — useless once the assistant has answered', () => {
      expect(push.sendToUser).toHaveBeenCalledWith(
        'a1',
        expect.objectContaining({ tag: 'conversation:c1' }),
        { urgency: 'high', ttlSeconds: 300 },
      );
    });
  });

  describe('a buyer writing into a held conversation', () => {
    it('alerts only the admin holding it', async () => {
      await service.onHeldMessage(
        new HeldConversationMessageEvent('c1', 'a2', 'Is it coming?', null),
      );

      expect(emitted[0]).toMatchObject({
        kind: 'HELD_CONVERSATION_MESSAGE',
        adminId: 'a2',
        title: 'The buyer replied',
        body: 'Is it coming?',
      });
      expect(pushedTo()).toEqual(['a2']);
      expect(users.find).not.toHaveBeenCalled();
    });

    it('trims a long message to a preview', async () => {
      await service.onHeldMessage(
        new HeldConversationMessageEvent('c1', 'a2', 'x'.repeat(500), 'Ada'),
      );

      expect(emitted[0].body.length).toBe(140);
      expect(emitted[0].body.endsWith('…')).toBe(true);
    });
  });

  it('announces a paid order with what was paid and who sold it', async () => {
    await service.onCheckoutPaid({
      reference: 'REC-AAA',
      buyerName: 'Ada',
      totalAmount: 6500,
      fulfillmentType: 'DELIVERY',
      orders: [{ vendorName: 'Mama Put' }, { vendorName: null }],
    } as unknown as CheckoutPaidEvent);

    expect(emitted[0]).toMatchObject({
      kind: 'NEW_PAID_ORDER',
      body: 'Ada paid ₦6,500 — Mama Put. Delivery.',
      url: '/admin/transactions',
    });
    expect(pushedTo()).toEqual(['a1', 'a2']);
  });

  it("tells admins why a withdrawal failed, which the vendor isn't shown", async () => {
    await service.onWithdrawalFailed(
      new WithdrawalFailedEvent(
        'v1',
        'w1',
        'WDR-AAA',
        4800,
        'Recipient account is frozen',
        false,
      ),
    );

    expect(emitted[0]).toMatchObject({
      kind: 'WITHDRAWAL_FAILED',
      title: 'Withdrawal failed',
      url: '/admin/vendors/v1',
    });
    expect(emitted[0].body).toContain('Mama Put wallet (WDR-AAA)');
    expect(emitted[0].body).toContain('Recipient account is frozen');
  });

  it('never throws when push is down', async () => {
    push.sendToUser.mockRejectedValue(new Error('gateway down'));

    await expect(
      service.onNeedsAttention(
        new ConversationNeedsAttentionEvent('c1', 'Stuck', null),
      ),
    ).resolves.toBeUndefined();
    // The open panels still heard it.
    expect(emitted).toHaveLength(1);
  });

  it('never throws when the admin list cannot be read', async () => {
    users.find.mockRejectedValue(new Error('db down'));

    await expect(
      service.onNeedsAttention(
        new ConversationNeedsAttentionEvent('c1', 'Stuck', null),
      ),
    ).resolves.toBeUndefined();
    expect(emitted).toHaveLength(1);
  });
});
