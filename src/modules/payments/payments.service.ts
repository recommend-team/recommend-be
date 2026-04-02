import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';

export interface PaystackInitResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly secretKey: string;
  private readonly baseUrl = 'https://api.paystack.co';

  constructor(private readonly configService: ConfigService) {
    this.secretKey =
      this.configService.get<string>('PAYSTACK_SECRET_KEY') ?? '';
    if (!this.secretKey) {
      this.logger.warn(
        'PAYSTACK_SECRET_KEY is not set — payments will not work',
      );
    }
  }

  /**
   * Initialize a Paystack transaction.
   * @param email   Buyer email (Paystack requires it; use a fallback if none)
   * @param amountNgn  Total amount in NGN (will be converted to kobo)
   * @param reference  Unique order reference
   * @param metadata   Arbitrary metadata stored on the transaction
   */
  async initializePayment(params: {
    email: string;
    amountNgn: number;
    reference: string;
    metadata?: Record<string, unknown>;
  }): Promise<PaystackInitResult> {
    const amountKobo = Math.round(params.amountNgn * 100);

    const body = JSON.stringify({
      email: params.email,
      amount: amountKobo,
      reference: params.reference,
      metadata: params.metadata ?? {},
    });

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/transaction/initialize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (err) {
      this.logger.error('Paystack network error', err);
      throw new InternalServerErrorException(
        'Payment gateway unavailable. Please try again.',
      );
    }

    const json = (await response.json()) as {
      status: boolean;
      message: string;
      data?: {
        authorization_url: string;
        access_code: string;
        reference: string;
      };
    };

    if (!response.ok || !json.status || !json.data) {
      this.logger.error('Paystack init failed', json);
      throw new InternalServerErrorException(
        json.message ?? 'Failed to initialize payment. Please try again.',
      );
    }

    return {
      authorizationUrl: json.data.authorization_url,
      accessCode: json.data.access_code,
      reference: json.data.reference,
    };
  }

  /**
   * Verify that a webhook request genuinely came from Paystack.
   * Paystack signs the raw request body with HMAC-SHA512 using the secret key.
   */
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    const hash = createHmac('sha512', this.secretKey)
      .update(rawBody)
      .digest('hex');
    return hash === signature;
  }

  /**
   * Parse and validate a Paystack webhook payload.
   * Throws 400 if signature is invalid.
   */
  parseWebhook(
    rawBody: Buffer,
    signature: string,
  ): { event: string; data: Record<string, unknown> } {
    if (!this.verifyWebhookSignature(rawBody, signature)) {
      throw new BadRequestException('Invalid webhook signature');
    }

    const payload = JSON.parse(rawBody.toString('utf8')) as {
      event: string;
      data: Record<string, unknown>;
    };

    return { event: payload.event, data: payload.data };
  }
}
