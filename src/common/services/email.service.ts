import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as brevo from '@getbrevo/brevo';

export interface EmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  template?: string;
  context?: Record<string, any>;
  replyTo?: { email: string; name?: string };
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private apiInstance: brevo.TransactionalEmailsApi;

  constructor(private readonly configService: ConfigService) {
    this.apiInstance = new brevo.TransactionalEmailsApi();
    const apiKey = this.configService.get<string>('BREVO_API_KEY');
    if (apiKey) {
      this.apiInstance.setApiKey(
        brevo.TransactionalEmailsApiApiKeys.apiKey,
        apiKey,
      );
    }

    if (!apiKey || !this.configService.get<string>('BREVO_SENDER_EMAIL')) {
      this.logger.error(
        'BREVO_API_KEY or BREVO_SENDER_EMAIL is not set — NO EMAIL WILL BE SENT. ' +
          'Vendors will not be told about orders, and payout verification codes will ' +
          'not arrive.',
      );
    }
  }

  async sendEmail(options: EmailOptions): Promise<void> {
    const senderEmail = this.configService.get<string>('BREVO_SENDER_EMAIL');

    if (!senderEmail) {
      throw new InternalServerErrorException(
        'BREVO_SENDER_EMAIL is not configured',
      );
    }

    if (!this.configService.get<string>('BREVO_API_KEY')) {
      throw new InternalServerErrorException('BREVO_API_KEY is not configured');
    }

    try {
      console.log('📧 Attempting to send email...');
      console.log('From:', senderEmail);
      console.log('To:', options.to);
      console.log('Subject:', options.subject);

      await this.sendWithBREVO({
        from: senderEmail,
        ...options,
      });
    } catch (error) {
      console.error('Email sending failed:', error);
      throw new InternalServerErrorException('Failed to send email');
    }
  }

  private async sendWithBREVO(
    options: EmailOptions & { from: string },
  ): Promise<void> {
    const sendSmtpEmail = new brevo.SendSmtpEmail();

    sendSmtpEmail.sender = {
      email: options.from,
    };

    sendSmtpEmail.to = [{ email: options.to }];
    sendSmtpEmail.subject = options.subject;
    if (options.replyTo) sendSmtpEmail.replyTo = options.replyTo;

    const htmlContent =
      options.html ||
      this.generateHtmlFromTemplate(options.template || '', options.context);
    sendSmtpEmail.htmlContent = htmlContent;

    if (options.text) {
      sendSmtpEmail.textContent = options.text;
    }

    try {
      const result = await this.apiInstance.sendTransacEmail(sendSmtpEmail);
      console.log(`✅ Email sent successfully to ${options.to}`);
      console.log('Brevo response:', JSON.stringify(result, null, 2));
    } catch (error) {
      const brevoError = error as {
        message?: string;
        response?: { data?: unknown; status?: number; statusText?: string };
      };
      console.error('❌ Error sending email:', error);
      console.error('Error details:', {
        message: brevoError.message,
        response: brevoError.response?.data,
        status: brevoError.response?.status,
        statusText: brevoError.response?.statusText,
      });
      throw error;
    }
  }

  private generateHtmlFromTemplate(
    template: string,
    context: Record<string, any> = {},
  ): string {
    // In production, use a templating engine like handlebars
    switch (template) {
      case 'email-verification':
        return `
          <h1>Verify your email address</h1>
          <p>Hello ${context.name},</p>
          <p>Thank you for registering with Recommend. Please click the link below to verify your email address:</p>
          <p><a href="${context.verificationUrl}">Verify Email</a></p>
          <p>This link will expire in 24 hours.</p>
          <p>If you didn't create an account, you can ignore this email.</p>
        `;
      case 'email-verification-code':
        return `
          <h1>Verify your email address</h1>
          <p>Hello ${context.name},</p>
          <p>Thank you for registering with Recommend. Your email verification code is:</p>
          <h2 style="background-color: #f0f0f0; padding: 10px; text-align: center; font-size: 24px; letter-spacing: 5px;">${context.code}</h2>
          <p>This code will expire in 5 minutes.</p>
          <p>If you didn't create an account, you can ignore this email.</p>
        `;
      case 'chat-sign-in-code':
        return `
          <h1>Your Recommend sign-in code</h1>
          <p>Enter this code in the Recommend chat to keep your chats and orders on any device:</p>
          <h2 style="background-color: #f0f0f0; padding: 10px; text-align: center; font-size: 24px; letter-spacing: 5px;">${context.code}</h2>
          <p>This code will expire in ${context.minutes} minutes.</p>
          <p>If you didn't ask for this, you can ignore this email — nobody can sign in without the code.</p>
        `;
      case 'password-reset':
        return `
          <h1>Reset your password</h1>
          <p>Hello ${context.name},</p>
          <p>You requested to reset your password. Click the link below to set a new password:</p>
          <p><a href="${context.resetUrl}">Reset Password</a></p>
          <p>This link will expire in 1 hour.</p>
          <p>If you didn't request a password reset, you can ignore this email.</p>
        `;
      case 'password-changed':
        return `
          <h1>Password changed successfully</h1>
          <p>Hello ${context.name},</p>
          <p>Your password was changed successfully on ${context.timestamp}.</p>
          <p>If you didn't make this change, please contact support immediately.</p>
        `;
      // Sent by an admin: an invite to an account they set up, or a fresh link.
      case 'set-password-link': {
        const name = escapeHtml(String(context.name ?? ''));
        const business = escapeHtml(
          String(context.businessName ?? 'your shop'),
        );
        const url = escapeHtml(String(context.url ?? ''));
        return context.invite
          ? `
          <h1>Your shop on Recommend is ready</h1>
          <p>Hello ${name},</p>
          <p>The Recommend team has set up <b>${business}</b> for you. Choose a password to sign in to the vendor app, where you can see your orders, your products and your earnings.</p>
          <p><a href="${url}">Set your password</a></p>
          <p>This link works for 72 hours. If it runs out, ask us for a new one.</p>
        `
          : `
          <h1>Set a new password</h1>
          <p>Hello ${name},</p>
          <p>The Recommend team sent you a link to set a new password for your vendor account.</p>
          <p><a href="${url}">Set a new password</a></p>
          <p>This link works for 72 hours. If you didn't ask us for this, you can ignore this email — your password stays as it is.</p>
        `;
      }
      // To the old address, when an admin changes a vendor's login email.
      case 'login-email-changed': {
        const name = escapeHtml(String(context.name ?? ''));
        const newEmail = escapeHtml(String(context.newEmail ?? ''));
        return `
          <h1>Your login email was changed</h1>
          <p>Hello ${name},</p>
          <p>The Recommend team changed the email you sign in with to <b>${newEmail}</b>. From now on, sign in with that address — this one will no longer work.</p>
          <p>If you didn't ask for this, contact us straight away.</p>
        `;
      }
      case 'account-approved':
        return `
          <h1>Your ${context.role} account has been approved! 🎉</h1>
          <p>Hello ${context.name},</p>
          <p>Great news! Your Recommend ${context.role} account has been reviewed and approved by our team.</p>
          <p>You can now log in and start using the platform.</p>
          <p>If you have any questions, please contact our support team.</p>
          <p>Welcome to Recommend!</p>
        `;
      case 'account-rejected':
        return `
          <h1>Your ${context.role} account application</h1>
          <p>Hello ${context.name},</p>
          <p>Thank you for applying to join Recommend as a ${context.role}.</p>
          <p>Unfortunately, after reviewing your application, we are unable to approve your account at this time.</p>
          ${context.reason ? `<p><strong>Reason:</strong> ${context.reason}</p>` : ''}
          <p>If you believe this is an error or would like to reapply with updated documents, please contact our support team.</p>
        `;
      case 'payout-account-code':
        return `
          <h1>Confirm your payout account</h1>
          <p>Hello ${context.name},</p>
          <p>Use this code to confirm <strong>${context.bankName} ${context.masked}</strong> (${context.accountName}) as a payout account:</p>
          <h2 style="background-color: #f0f0f0; padding: 10px; text-align: center; font-size: 24px; letter-spacing: 5px;">${context.code}</h2>
          <p>This code expires in ${context.minutes} minutes.</p>
          <p><strong>If you did not add this account, do not enter the code.</strong> Someone may be trying to redirect your earnings — change your password and contact support.</p>
        `;
      case 'payout-account-changed':
        return `
          <h1>Your payout accounts changed</h1>
          <p>Hello ${context.name},</p>
          <p><strong>${context.bankName} ${context.masked}</strong> was ${context.action} ${context.action === 'added' ? 'to' : 'from'} your Recommend payout accounts.</p>
          <p><strong>If this was not you, contact support immediately</strong> — this is how earnings get redirected.</p>
        `;
      case 'withdrawal-requested':
        return `
          <h1>Your withdrawal is on its way</h1>
          <p>Hello ${context.name},</p>
          <p><strong>₦${context.amountSent}</strong> is on its way to your bank, after a ₦${context.feeAmount} transfer fee.</p>
          <p>Reference: ${context.reference}</p>
          <p><strong>If you did not request this, contact support immediately.</strong></p>
        `;
      default:
        return '<p>Email from Recommend</p>';
    }
  }
}

/** For values typed by people (names, emails) going into an email's HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
