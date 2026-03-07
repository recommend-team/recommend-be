import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as brevo from '@getbrevo/brevo';

export interface EmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  template?: string;
  context?: Record<string, any>;
}

@Injectable()
export class EmailService {
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
      default:
        return '<p>Email from Recommend</p>';
    }
  }
}
