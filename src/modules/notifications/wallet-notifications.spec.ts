import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import { Notification, NotificationType } from './entities/notification.entity';
import { EmailService } from '../../common/services/email.service';
import { User } from '../auth/entities/auth.entity';
import {
  WalletCreditedEvent,
  WithdrawalFailedEvent,
  WithdrawalSettledEvent,
} from '../../common/events/wallet.events';

describe('wallet notifications', () => {
  let service: NotificationsService;
  let feed: Partial<Notification>[];
  let pushed: { userId: string; title: string; body: string }[];
  let push: { sendToUser: jest.Mock };

  beforeEach(async () => {
    feed = [];
    pushed = [];

    const notifications = {
      create: (row: Partial<Notification>) => row,
      save: (row: Partial<Notification>) => {
        feed.push(row);
        return Promise.resolve({ ...row, id: `n${feed.length}` });
      },
    };

    push = {
      sendToUser: jest.fn(
        (userId: string, payload: { title: string; body: string }) => {
          pushed.push({ userId, ...payload });
          return Promise.resolve(1);
        },
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: getRepositoryToken(Notification), useValue: notifications },
        { provide: getRepositoryToken(User), useValue: { findOne: jest.fn() } },
        { provide: PushService, useValue: push },
        { provide: EmailService, useValue: { sendEmail: jest.fn() } },
      ],
    }).compile();

    service = module.get(NotificationsService);
  });

  describe('being credited for a delivered order', () => {
    const credited = new WalletCreditedEvent('v1', 'o1', 4800, 'REC-AAA');

    it('writes it to the feed with the amount that landed', async () => {
      await service.onWalletCredited(credited);

      expect(feed).toHaveLength(1);
      expect(feed[0]).toMatchObject({
        userId: 'v1',
        type: NotificationType.WALLET_CREDITED,
      });
      expect(feed[0].body).toContain('4,800');
    });

    it('does not push', async () => {
      // Twenty orders a day would be twenty interruptions for something the vendor
      // already watched happen. The feed is the point here, not the buzz.
      await service.onWalletCredited(credited);

      expect(pushed).toHaveLength(0);
    });
  });

  describe('a withdrawal reaching the bank', () => {
    const settled = new WithdrawalSettledEvent('v1', 'w1', 'WDR-AAA', 4790);

    it('writes it to the feed', async () => {
      await service.onWithdrawalSettled(settled);

      expect(feed[0]).toMatchObject({
        type: NotificationType.WITHDRAWAL_SETTLED,
      });
      expect(feed[0].body).toContain('4,790');
    });

    it('pushes, because it is the end of the loop', async () => {
      await service.onWithdrawalSettled(settled);

      expect(pushed).toHaveLength(1);
      expect(pushed[0].title).toMatch(/paid out/i);
    });
  });

  describe('a withdrawal that did not arrive', () => {
    it('says the money is back, and pushes', async () => {
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

      expect(feed[0]).toMatchObject({
        type: NotificationType.WITHDRAWAL_FAILED,
      });
      expect(feed[0].body).toContain('back in your wallet');
      expect(pushed).toHaveLength(1);
    });

    it('distinguishes a reversal from a refusal', async () => {
      // "Sent then returned" and "never went out" look the same in the balance and mean
      // different things to whoever has to fix it.
      await service.onWithdrawalFailed(
        new WithdrawalFailedEvent(
          'v1',
          'w1',
          'WDR-AAA',
          4800,
          'bank returned it',
          true,
        ),
      );

      expect(feed[0].title).toMatch(/returned/i);
      expect(feed[0].body).toMatch(/sent but the bank returned/i);
    });

    it("keeps Paystack's wording out of the vendor's face but on the record", async () => {
      await service.onWithdrawalFailed(
        new WithdrawalFailedEvent(
          'v1',
          'w1',
          'WDR-AAA',
          4800,
          'You cannot initiate third party payouts as a starter business',
          false,
        ),
      );

      expect(feed[0].body).not.toContain('starter business');
      expect(feed[0].data).toMatchObject({
        reason: 'You cannot initiate third party payouts as a starter business',
      });
    });
  });

  it('never lets a failed notification unwind the money that caused it', async () => {
    push.sendToUser.mockRejectedValue(new Error('push gateway down'));

    await expect(
      service.onWithdrawalSettled(
        new WithdrawalSettledEvent('v1', 'w1', 'WDR-AAA', 4790),
      ),
    ).resolves.toBeUndefined();
  });
});
