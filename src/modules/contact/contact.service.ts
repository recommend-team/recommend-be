import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { EmailService } from '../../common/services/email.service';
import type { ContactMessage } from './contact.schema';

const HOUR_SECONDS = 60 * 60;

/**
 * The website's contact form: a message from anyone, emailed to the team's inbox with the
 * visitor as reply-to, so answering is just Reply.
 *
 * The endpoint is open, so it is capped three ways per hour — per address the request came
 * from, per sender email, and overall. The first can be dodged by faking a header, the
 * second by changing the email; the overall cap holds whatever is faked, so the inbox can
 * never be flooded.
 */
@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);

  constructor(
    private readonly emails: EmailService,
    private readonly config: ConfigService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  async submit(message: ContactMessage, clientIp: string): Promise<void> {
    // Bots fill every field. Pretend it worked, so they learn nothing.
    if (message.website?.trim()) {
      this.logger.warn(
        `Dropped a contact message caught by the honeypot (${clientIp})`,
      );
      return;
    }

    const perSender =
      this.config.get<number>('contact.maxPerSenderPerHour') ?? 5;
    const overall = this.config.get<number>('contact.maxPerHour') ?? 60;
    const hour = Math.floor(Date.now() / (HOUR_SECONDS * 1000));

    await this.limit(`contact:ip:${clientIp}`, perSender);
    await this.limit(`contact:email:${message.email.toLowerCase()}`, perSender);
    await this.limit(`contact:all:${hour}`, overall, true);

    const inbox = this.config.get<string>('contact.inbox')!;
    try {
      await this.emails.sendEmail({
        to: inbox,
        replyTo: { email: message.email, name: message.fullName },
        subject: `Contact: ${message.topic} — ${message.fullName}`,
        text: plainText(message),
        html: html(message),
      });
    } catch (error) {
      this.logger.error(
        `Contact message from ${message.email} could not be sent: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      throw new ServiceUnavailableException(
        "We couldn't send your message just now. Please try again in a moment.",
      );
    }
  }

  /** Counts this request against a cap; refuses once it is passed. */
  private async limit(
    key: string,
    max: number,
    everyone = false,
  ): Promise<void> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, HOUR_SECONDS);
    if (count > max) {
      throw new HttpException(
        everyone
          ? "We're receiving a lot of messages right now. Please try again shortly, or email us directly."
          : "You've sent several messages in the last hour. We'll reply to those — or email us directly.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

function lines(message: ContactMessage): [string, string][] {
  return [
    ['Name', message.fullName],
    ['Email', message.email],
    ...(message.phoneNumber
      ? [['Phone', message.phoneNumber] as [string, string]]
      : []),
    ['Topic', message.topic],
    ...(message.orderReference
      ? [['Order', message.orderReference] as [string, string]]
      : []),
  ];
}

function plainText(message: ContactMessage): string {
  return [
    ...lines(message).map(([label, value]) => `${label}: ${value}`),
    '',
    message.message,
    '',
    '— Sent from the contact form on the Recommend website. Reply to answer the sender.',
  ].join('\n');
}

/** Everything the visitor typed is escaped — this lands in an inbox that renders HTML. */
function html(message: ContactMessage): string {
  const rows = lines(message)
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 16px 4px 0;color:#6b7280">${escape(label)}</td><td style="padding:4px 0"><b>${escape(value)}</b></td></tr>`,
    )
    .join('');

  return `
    <div style="font-family:Arial,sans-serif;font-size:15px;color:#1a1a1a">
      <p style="margin:0 0 12px;font-size:13px;color:#006837"><b>NEW MESSAGE FROM THE WEBSITE</b></p>
      <table style="border-collapse:collapse;margin-bottom:16px">${rows}</table>
      <div style="white-space:pre-wrap;line-height:1.55;padding:14px;background:#fffdf2;border-radius:8px">${escape(message.message)}</div>
      <p style="margin:16px 0 0;font-size:12px;color:#6b7280">Reply to this email to answer ${escape(message.fullName)}.</p>
    </div>`;
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
