import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';
import {
  buildWelcomeEmail,
  type WelcomeAudience,
} from '../emails/welcome.email';

/**
 * Sends the founder's welcome note, once, at a new user's first verification.
 *
 * Never throws. A welcome that fails to send must not fail the sign-up it celebrates —
 * the account is made, and the failure is logged.
 */
@Injectable()
export class WelcomeEmailService {
  private readonly logger = new Logger(WelcomeEmailService.name);

  constructor(
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  async send(
    audience: WelcomeAudience,
    to: string,
    firstName?: string | null,
  ): Promise<void> {
    try {
      const welcome = buildWelcomeEmail(audience, firstName, {
        websiteUrl:
          this.config.get<string>('brand.websiteUrl') ??
          'https://recommend-fe.netlify.app',
        customerAppUrl: this.config.get<string>('brand.customerAppUrl') ?? '',
        vendorAppUrl: this.config.get<string>('brand.vendorAppUrl') ?? '',
      });

      await this.email.sendEmail({
        to,
        subject: welcome.subject,
        html: welcome.html,
        text: welcome.text,
        // "Reply and tell me" only works if the reply reaches someone.
        replyTo: {
          email:
            this.config.get<string>('contact.inbox') ??
            'contacts.recommend@gmail.com',
          name: 'Chanor James, Recommend',
        },
      });
    } catch (error) {
      this.logger.error(
        `Could not send the ${audience} welcome email: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
