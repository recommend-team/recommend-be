import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import * as webpush from 'web-push';
import { PushService } from './push.service';
import { PushSubscription } from './entities/push-subscription.entity';

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));

const sendNotification = webpush.sendNotification as jest.Mock;

const device = (id: string) => ({
  id,
  endpoint: `https://push.example/${id}`,
  keys: { p256dh: 'p', auth: 'a' },
});

describe('PushService', () => {
  let service: PushService;
  let subscriptions: { find: jest.Mock; delete: jest.Mock };

  beforeEach(async () => {
    sendNotification.mockReset().mockResolvedValue({});
    subscriptions = {
      find: jest.fn().mockResolvedValue([device('d1')]),
      delete: jest.fn(),
    };

    const config: Record<string, string> = {
      'push.publicKey': 'public',
      'push.privateKey': 'private',
    };

    const module = await Test.createTestingModule({
      providers: [
        PushService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => config[key] },
        },
        {
          provide: getRepositoryToken(PushSubscription),
          useValue: subscriptions,
        },
      ],
    }).compile();

    service = module.get(PushService);
  });

  it('sends the payload as JSON, with the requested urgency and lifetime', async () => {
    await service.sendToUser(
      'v1',
      { title: 'New paid order', body: '…', url: '/orders/o1' },
      { urgency: 'high', ttlSeconds: 3600 },
    );

    const [, body, options] = sendNotification.mock.calls[0] as [
      unknown,
      string,
      unknown,
    ];
    expect(JSON.parse(body)).toMatchObject({ url: '/orders/o1' });
    expect(options).toEqual({ urgency: 'high', TTL: 3600 });
  });

  it("leaves web-push's defaults alone when nothing is asked for", async () => {
    await service.sendToUser('v1', { title: 't', body: 'b' });

    const [, , options] = sendNotification.mock.calls[0] as [
      unknown,
      string,
      unknown,
    ];
    expect(options).toEqual({});
  });

  it('forgets a device the push service says is gone', async () => {
    sendNotification.mockRejectedValue({ statusCode: 410 });

    await expect(
      service.sendToUser('v1', { title: 't', body: 'b' }),
    ).resolves.toBe(0);
    expect(subscriptions.delete).toHaveBeenCalledWith({
      endpoint: In(['https://push.example/d1']),
    });
  });

  describe('delivering to devices held elsewhere', () => {
    it('sends to each, and reports the ones that are gone for the caller to forget', async () => {
      sendNotification
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce({ statusCode: 404 });

      await expect(
        service.deliver([device('d1'), device('d2')], {
          title: 't',
          body: 'b',
        }),
      ).resolves.toEqual({ delivered: 1, gone: ['https://push.example/d2'] });
      // Not this module's table — nothing is deleted here.
      expect(subscriptions.delete).not.toHaveBeenCalled();
    });

    it('never throws on an ordinary failure', async () => {
      sendNotification.mockRejectedValue(new Error('network down'));

      await expect(
        service.deliver([device('d1')], { title: 't', body: 'b' }),
      ).resolves.toEqual({ delivered: 0, gone: [] });
    });
  });
});
