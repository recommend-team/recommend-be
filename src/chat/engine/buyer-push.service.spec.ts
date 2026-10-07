import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { BuyerPushService } from './buyer-push.service';
import { BuyerPushSubscription } from '../conversation/entities/buyer-push-subscription.entity';
import { PUSH_PORT } from '../ports/push.port';
import type { BuyerPushMessage } from '../ports/push.port';

const valid = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: 'BPub', auth: 'secret' },
  userAgent: 'Mozilla/5.0',
};

const message: BuyerPushMessage = {
  title: 'On its way',
  body: 'Your delivery code is KDPXRM.',
  type: 'ORDER_DISPATCHED',
  url: '/',
  tag: 'order:REC-AAA',
};

describe('BuyerPushService', () => {
  let service: BuyerPushService;
  let repository: { upsert: jest.Mock; delete: jest.Mock; find: jest.Mock };
  let port: { isEnabled: jest.Mock; deliver: jest.Mock };

  beforeEach(async () => {
    repository = {
      upsert: jest.fn(),
      delete: jest.fn(),
      find: jest.fn().mockResolvedValue([
        {
          endpoint: 'https://push.example/a',
          keys: { p256dh: 'p', auth: 'a' },
        },
        {
          endpoint: 'https://push.example/b',
          keys: { p256dh: 'p', auth: 'a' },
        },
      ]),
    };
    port = {
      isEnabled: jest.fn().mockReturnValue(true),
      deliver: jest.fn().mockResolvedValue({ gone: [] }),
    };

    const module = await Test.createTestingModule({
      providers: [
        BuyerPushService,
        {
          provide: getRepositoryToken(BuyerPushSubscription),
          useValue: repository,
        },
        { provide: PUSH_PORT, useValue: port },
      ],
    }).compile();

    service = module.get(BuyerPushService);
  });

  describe('registering a device', () => {
    it('stores it against the conversation the socket belongs to', async () => {
      await expect(service.subscribe('c1', valid)).resolves.toBe(true);

      expect(repository.upsert).toHaveBeenCalledWith(
        { conversationId: 'c1', ...valid },
        { conflictPaths: ['endpoint'] },
      );
    });

    it.each([
      [
        'a plain-http endpoint',
        { ...valid, endpoint: 'http://push.example/a' },
      ],
      ['a non-URL endpoint', { ...valid, endpoint: 'not a url' }],
      ['a missing key', { ...valid, keys: { p256dh: 'BPub' } }],
      ['an empty key', { ...valid, keys: { p256dh: '', auth: 'x' } }],
      [
        'an absurdly long endpoint',
        { ...valid, endpoint: `https://x.example/${'a'.repeat(2000)}` },
      ],
      ['nothing at all', {}],
    ])('refuses %s', async (_label, input) => {
      // It is where our server will send requests, so it is checked before it is kept.
      await expect(service.subscribe('c1', input)).resolves.toBe(false);
      expect(repository.upsert).not.toHaveBeenCalled();
    });
  });

  it('only lets a device unsubscribe from its own conversation', async () => {
    await service.unsubscribe('c1', valid.endpoint);

    expect(repository.delete).toHaveBeenCalledWith({
      conversationId: 'c1',
      endpoint: valid.endpoint,
    });
  });

  describe('notifying', () => {
    it('sends to every device on the conversation', async () => {
      await service.notify('c1', message, { urgency: 'high' });

      expect(repository.find).toHaveBeenCalledWith({
        where: { conversationId: 'c1' },
      });
      expect(port.deliver).toHaveBeenCalledWith(
        [
          {
            endpoint: 'https://push.example/a',
            keys: { p256dh: 'p', auth: 'a' },
          },
          {
            endpoint: 'https://push.example/b',
            keys: { p256dh: 'p', auth: 'a' },
          },
        ],
        message,
        { urgency: 'high' },
      );
    });

    it('forgets devices the push service says are gone', async () => {
      port.deliver.mockResolvedValue({ gone: ['https://push.example/b'] });

      await service.notify('c1', message);

      expect(repository.delete).toHaveBeenCalledWith({
        endpoint: In(['https://push.example/b']),
      });
    });

    it('does no work at all when push is switched off', async () => {
      port.isEnabled.mockReturnValue(false);

      await service.notify('c1', message);

      expect(repository.find).not.toHaveBeenCalled();
    });

    it('never throws — a buyer who cannot be nudged fails nothing else', async () => {
      repository.find.mockRejectedValue(new Error('db down'));

      await expect(service.notify('c1', message)).resolves.toBeUndefined();
    });
  });
});
