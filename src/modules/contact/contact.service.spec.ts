import {
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContactService } from './contact.service';
import { contactSchema, type ContactMessage } from './contact.schema';
import type {
  EmailOptions,
  EmailService,
} from '../../common/services/email.service';

const message = (over: Partial<ContactMessage> = {}): ContactMessage => ({
  fullName: 'Ada Okafor',
  email: 'ada@example.com',
  topic: 'Order or delivery',
  orderReference: 'REC-123',
  message: 'My jollof never arrived.',
  ...over,
});

/** An in-memory Redis with the two calls the service makes. */
function fakeRedis() {
  const counts = new Map<string, number>();
  return {
    counts,
    incr: jest.fn((key: string) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return Promise.resolve(counts.get(key)!);
    }),
    expire: jest.fn(() => Promise.resolve(1)),
  };
}

describe('ContactService', () => {
  let sendEmail: jest.Mock<Promise<void>, [EmailOptions]>;
  /** The email the service handed to EmailService. */
  const sent = (call = 0): EmailOptions => sendEmail.mock.calls[call][0];
  let redis: ReturnType<typeof fakeRedis>;
  let service: ContactService;

  beforeEach(() => {
    sendEmail = jest.fn<Promise<void>, [EmailOptions]>().mockResolvedValue();
    redis = fakeRedis();
    const config = new ConfigService({
      contact: {
        inbox: 'team@recommend.test',
        maxPerSenderPerHour: 3,
        maxPerHour: 5,
      },
    });
    service = new ContactService(
      { sendEmail } as unknown as EmailService,
      config,
      redis as never,
    );
  });

  it('emails the inbox, with the visitor as reply-to', async () => {
    await service.submit(message(), '1.2.3.4');

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sent().to).toBe('team@recommend.test');
    expect(sent().replyTo).toEqual({
      email: 'ada@example.com',
      name: 'Ada Okafor',
    });
    expect(sent().subject).toBe('Contact: Order or delivery — Ada Okafor');
    expect(sent().text).toContain('Order: REC-123');
    expect(sent().text).toContain('My jollof never arrived.');
  });

  it('escapes what the visitor typed before it reaches an HTML inbox', async () => {
    await service.submit(
      message({
        fullName: '<b>Eve</b>',
        message: '<script>alert(1)</script> hello',
      }),
      'x',
    );

    const html = sent().html ?? '';
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<b>Eve</b>');
  });

  it('leaves out lines the visitor did not fill in', async () => {
    await service.submit(
      message({ orderReference: undefined, phoneNumber: undefined }),
      'x',
    );

    const text = sent().text ?? '';
    expect(text).not.toContain('Order:');
    expect(text).not.toContain('Phone:');
  });

  it('quietly drops a message that filled the honeypot', async () => {
    await expect(
      service.submit(message({ website: 'http://spam.example' }), 'x'),
    ).resolves.toBeUndefined();

    expect(sendEmail).not.toHaveBeenCalled();
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('caps one sender per hour, even from new addresses', async () => {
    for (let i = 0; i < 3; i++) await service.submit(message(), `10.0.0.${i}`);

    const error = await service
      .submit(message(), '10.0.0.9')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });

  it('caps everyone together, however the senders vary', async () => {
    for (let i = 0; i < 5; i++) {
      await service.submit(
        message({ email: `p${i}@example.com` }),
        `10.1.0.${i}`,
      );
    }

    await expect(
      service.submit(message({ email: 'p9@example.com' }), '10.1.0.9'),
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
  });

  it('says so plainly when the email cannot be sent', async () => {
    sendEmail.mockRejectedValue(new Error('Brevo down'));

    await expect(service.submit(message(), 'x')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('contactSchema', () => {
  const valid = {
    fullName: 'Ada Okafor',
    email: 'ada@example.com',
    topic: 'Something else',
    message: 'Hello, a question about your service.',
  };

  it('accepts a complete message, trimming and dropping empty extras', () => {
    const parsed = contactSchema.parse({
      ...valid,
      fullName: '  Ada  ',
      phoneNumber: '',
      orderReference: ' ',
    });

    expect(parsed.fullName).toBe('Ada');
    expect(parsed.phoneNumber).toBeUndefined();
    expect(parsed.orderReference).toBeUndefined();
  });

  it.each([
    ['a short name', { fullName: 'A' }],
    ['a bad email', { email: 'not-an-email' }],
    ['an unknown topic', { topic: 'Bribes' }],
    ['a one-word message', { message: 'hi' }],
    ['a bad phone', { phoneNumber: 'call me' }],
  ])('rejects %s', (_label, over) => {
    expect(contactSchema.safeParse({ ...valid, ...over }).success).toBe(false);
  });
});
