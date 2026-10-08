import { Injectable } from '@nestjs/common';
import { EmailService } from '../../common/services/email.service';
import type { EmailPort } from '../ports/email.port';

/** In-process implementation of `EmailPort`, over the platform's Brevo sender. */
@Injectable()
export class LocalEmailAdapter implements EmailPort {
  constructor(private readonly email: EmailService) {}

  async sendSignInCode(
    to: string,
    code: string,
    minutesValid: number,
  ): Promise<void> {
    await this.email.sendEmail({
      to,
      subject: `${code} is your Recommend code`,
      template: 'chat-sign-in-code',
      context: { code, minutes: minutesValid },
      text: `Your Recommend sign-in code is ${code}. It expires in ${minutesValid} minutes. If you didn't ask for this, ignore this email.`,
    });
  }
}
