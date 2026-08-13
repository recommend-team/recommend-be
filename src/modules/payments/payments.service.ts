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

export interface Bank {
  name: string;
  code: string;
  slug: string;
}

export interface ResolvedAccount {
  accountNumber: string;
  accountName: string;
}

/** Paystack rejected the account itself — not a network or credential problem. */
export class AccountResolutionError extends Error {}

/**
 * The money has not settled into our Paystack balance yet. Retryable, and the ordinary
 * case for a withdrawal requested the same day the order was paid for.
 */
export class InsufficientPaystackBalanceError extends Error {}

/** Paystack will never accept this transfer. Retrying cannot help. */
export class TransferRejectedError extends Error {}
export class TransferOtpRequiredError extends Error {}

export interface TransferResult {
  transferCode: string;
  /** Paystack's own word: `success`, `pending`, `otp`, … */
  status: string;
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

  async verifyTransaction(reference: string): Promise<{
    /** Paystack's own vocabulary: success, failed, abandoned, ongoing, pending… */
    status: string;
    /** What was actually charged, in naira. Null when Paystack did not say. */
    amountNgn: number | null;
    paidAt: Date | null;
  }> {
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${this.secretKey}` } },
      );
    } catch (err) {
      this.logger.error(`Paystack verify network error for ${reference}`, err);
      throw new InternalServerErrorException(
        'Could not reach the payment gateway. Please try again.',
      );
    }

    const json = (await response.json()) as {
      status: boolean;
      message: string;
      data?: { status?: string; amount?: number; paid_at?: string | null };
    };

    if (response.status === 404) {
      return { status: 'unknown', amountNgn: null, paidAt: null };
    }

    if (!response.ok || !json.status || !json.data) {
      this.logger.error(`Paystack verify failed for ${reference}`, json);
      throw new InternalServerErrorException(
        json.message ?? 'Could not verify this payment. Please try again.',
      );
    }

    return {
      status: json.data.status ?? 'unknown',
      amountNgn:
        typeof json.data.amount === 'number' ? json.data.amount / 100 : null,
      paidAt: json.data.paid_at ? new Date(json.data.paid_at) : null,
    };
  }

  // ─── Payouts ────────────────────────────────────────────────────────────────

  /**
   * Every bank Paystack can send to. The vendor picks from this, so an unsupported bank
   * is unselectable rather than a failure discovered at the first withdrawal.
   */
  async listBanks(): Promise<Bank[]> {
    const json = await this.get<{ name: string; code: string; slug: string }[]>(
      '/bank?currency=NGN&perPage=200',
      'load the bank list',
    );

    return json.map((bank) => ({
      name: bank.name,
      code: bank.code,
      slug: bank.slug,
    }));
  }

  /**
   * Prove the account exists at that bank, and get the name it is actually held under.
   *
   * The resolved name is authoritative over anything the user typed — that is the whole
   * point of asking Paystack rather than trusting a form field.
   */
  async resolveAccount(
    accountNumber: string,
    bankCode: string,
  ): Promise<ResolvedAccount> {
    const query = `account_number=${encodeURIComponent(
      accountNumber,
    )}&bank_code=${encodeURIComponent(bankCode)}`;

    const json = await this.get<{
      account_number: string;
      account_name: string;
    }>(`/bank/resolve?${query}`, 'verify that account', AccountResolutionError);

    return {
      accountNumber: json.account_number,
      accountName: json.account_name,
    };
  }

  /** The handle a transfer is addressed to. Created once per account. */
  async createTransferRecipient(params: {
    name: string;
    accountNumber: string;
    bankCode: string;
  }): Promise<string> {
    const json = await this.post<{ recipient_code: string }>(
      '/transferrecipient',
      {
        type: 'nuban',
        name: params.name,
        account_number: params.accountNumber,
        bank_code: params.bankCode,
        currency: 'NGN',
      },
      'register that account for payouts',
      AccountResolutionError,
    );

    return json.recipient_code;
  }

  /**
   * Send money to a recipient.
   *
   * `reference` is ours and is reused on every retry, so Paystack deduplicates and a
   * retry can never send twice. That property is what makes the retry loop safe.
   *
   * Failures are typed by whether retrying could ever help — an unsettled balance clears
   * on its own, a frozen account never does, and treating them alike either gives up on
   * money that would have arrived or retries forever against a wall.
   */
  async initiateTransfer(params: {
    amountNgn: number;
    recipientCode: string;
    reference: string;
    reason: string;
  }): Promise<TransferResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/transfer`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source: 'balance',
          amount: Math.round(params.amountNgn * 100),
          recipient: params.recipientCode,
          reference: params.reference,
          reason: params.reason,
        }),
      });
    } catch (err) {
      this.logger.error(`Paystack network error on transfer`, err);
      throw new InternalServerErrorException(
        'Could not reach the payment gateway to send that transfer.',
      );
    }

    const json = (await response.json()) as {
      status: boolean;
      message?: string;
      data?: { transfer_code?: string; status?: string };
    };

    if (!response.ok || !json.status || !json.data) {
      const message = json.message ?? 'Paystack refused the transfer.';

      if (isInsufficientBalance(message)) {
        throw new InsufficientPaystackBalanceError(message);
      }
      if (response.status >= 500) {
        throw new InternalServerErrorException(message);
      }
      throw new TransferRejectedError(message);
    }

    if (json.data.status === 'otp') {
      throw new TransferOtpRequiredError(
        'Paystack is requiring an OTP for transfers. Disable Transfers OTP in the ' +
          'Paystack dashboard — no withdrawal can complete until it is off.',
      );
    }

    return {
      transferCode: json.data.transfer_code ?? '',
      status: json.data.status ?? 'pending',
    };
  }

  // ─── Transport ──────────────────────────────────────────────────────────────

  private async get<T>(
    path: string,
    action: string,
    RejectionError?: new (message: string) => Error,
  ): Promise<T> {
    return this.call<T>('GET', path, undefined, action, RejectionError);
  }

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
    action: string,
    RejectionError?: new (message: string) => Error,
  ): Promise<T> {
    return this.call<T>('POST', path, body, action, RejectionError);
  }

  /**
   * A Paystack call, with the two failures kept apart: we could not reach them, versus
   * they answered and said no. The first is ours to retry, the second is the user's to fix.
   */
  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    action: string,
    RejectionError?: new (message: string) => Error,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      this.logger.error(`Paystack network error on ${path}`, err);
      throw new InternalServerErrorException(
        `Could not reach the payment gateway to ${action}. Please try again.`,
      );
    }

    const json = (await response.json()) as {
      status: boolean;
      message?: string;
      data?: T;
    };

    if (!response.ok || !json.status || json.data === undefined) {
      const message = json.message ?? `Could not ${action}.`;
      this.logger.warn(`Paystack refused ${path}: ${message}`);
      if (RejectionError && response.status >= 400 && response.status < 500) {
        throw new RejectionError(message);
      }
      throw new InternalServerErrorException(message);
    }

    return json.data;
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

/**
 * Paystack has no error code for this, only prose, so the wording is all there is to go
 * on.
 */
function isInsufficientBalance(message: string): boolean {
  const normalised = message.toLowerCase();
  return (
    normalised.includes('balance is not enough') ||
    normalised.includes('insufficient balance') ||
    normalised.includes('insufficient funds')
  );
}
