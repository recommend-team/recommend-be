import { registerAs } from '@nestjs/config';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

export default registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  apiPrefix: process.env.API_PREFIX || 'api/v1',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:4000',
  vendorAppUrl: process.env.VENDOR_APP_URL || '',
}));

const stripSslMode = (url: string): string => {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('sslmode');
    return parsed.toString();
  } catch {
    return url;
  }
};

export const databaseConfig = registerAs('database', () => {
  const entities = [__dirname + '/../**/*.entity{.ts,.js}'];
  const migrations = [__dirname + '/../database/migrations/*{.ts,.js}'];

  const synchronize =
    process.env.NODE_ENV !== 'production' &&
    process.env.DATABASE_SYNCHRONIZE === 'true';

  const relaxTls = process.env.DATABASE_SSL === 'true';

  const url =
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/recommend_db';

  return {
    type: 'postgres' as const,
    url: relaxTls ? stripSslMode(url) : url,
    ssl: relaxTls ? { rejectUnauthorized: false } : undefined,
    entities,
    migrations,
    migrationsRun: !synchronize,
    synchronize,
    logging:
      process.env.NODE_ENV !== 'production' &&
      process.env.DATABASE_LOGGING === 'true',
    dropSchema: false,
  };
});

// Helper function for TypeORM DataSource (used in data-source.ts)
export const getTypeOrmConfig = (): PostgresConnectionOptions => {
  const config = databaseConfig();
  return {
    type: config.type,
    url: config.url,
    ssl: config.ssl,
    entities: config.entities,
    migrations: config.migrations,
    migrationsTableName: 'migrations',
    migrationsRun: config.migrationsRun,
    synchronize: config.synchronize,
    logging: config.logging,
    dropSchema: config.dropSchema,
  };
};

export const redisConfig = registerAs('redis', () => ({
  /**
   * Full connection string, e.g. Upstash's `rediss://default:<token>@host:6379`.
   * Takes precedence over the host/port/password trio — a managed provider hands you
   * one URL, and splitting it by hand is how the TLS scheme gets dropped.
   * The `rediss://` scheme (two s) is what enables TLS.
   */
  url: process.env.REDIS_URL,
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD,
  ttl: parseInt(process.env.REDIS_TTL || '86400', 10),
}));

export const jwtConfig = registerAs('jwt', () => ({
  secret: process.env.JWT_SECRET,
  expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  refreshSecret: process.env.JWT_REFRESH_SECRET,
  refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
}));

export const whatsappConfig = registerAs('whatsapp', () => ({
  apiVersion: process.env.WHATSAPP_API_VERSION || 'v19.0',
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
  webhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  webhookSecret: process.env.WHATSAPP_WEBHOOK_SECRET,
}));

export const cloudinaryConfig = registerAs('cloudinary', () => ({
  cloudName: process.env.CLOUDINARY_CLOUD_NAME,
  apiKey: process.env.CLOUDINARY_API_KEY,
  apiSecret: process.env.CLOUDINARY_API_SECRET,
}));

export const openaiConfig = registerAs('openai', () => ({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.2'),
}));

// No `emailConfig` here. `EmailService` reads BREVO_API_KEY and BREVO_SENDER_EMAIL
// directly; an SMTP namespace nothing consumed only advertised variables that do nothing.

export const paymentConfig = registerAs('payment', () => ({
  provider: process.env.PAYMENT_PROVIDER || 'paystack',
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY,
  paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY,
  webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET,
}));
export const googleConfig = registerAs('google', () => ({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackUrl:
    process.env.GOOGLE_CALLBACK_URL ||
    'http://localhost:4000/api/v1/auth/google/callback',
  backendUrl: process.env.BACKEND_URL || 'http://localhost:4000',
}));

export const chatConfig = registerAs('chat', () => ({
  /**
   * How many past messages go to the model. The main lever on per-turn token cost —
   * every extra message is paid for on every turn of every conversation.
   */
  maxHistoryMessages: parseInt(
    process.env.CHAT_MAX_HISTORY_MESSAGES || '12',
    10,
  ),
  /** Tool round-trips allowed per turn, so a confused model cannot loop indefinitely. */
  maxToolRounds: parseInt(process.env.CHAT_MAX_TOOL_ROUNDS || '3', 10),
  /** Per-session message caps. A WebSocket bypasses ThrottlerModule entirely. */
  rateLimitPerMinute: parseInt(
    process.env.CHAT_RATE_LIMIT_PER_MINUTE || '20',
    10,
  ),
  rateLimitPerHour: parseInt(process.env.CHAT_RATE_LIMIT_PER_HOUR || '200', 10),
  /**
   * How long an admin can be silent before a waiting buyer gets the assistant back.
   *
   * Measured from the admin's last message and checked only when a buyer speaks, so a
   * hold is never released into a live conversation — and never leaves anyone waiting on
   * a person who has gone.
   */
  adminHandoverStaleMinutes: parseInt(
    process.env.ADMIN_HANDOVER_STALE_MINUTES || '30',
    10,
  ),
}));

export const deliveryConfig = registerAs('delivery', () => ({
  feeNgn: parseInt(process.env.DELIVERY_FEE_NGN || '1500', 10),
}));

export const platformConfig = registerAs('platform', () => {
  const feePercent = parseInt(process.env.PLATFORM_FEE_PERCENT || '20', 10);
  return {
    feePercent,
    /** The fraction checkout multiplies a vendor's subtotal by. Converted once, here. */
    feeRate: feePercent / 100,
  };
});

export const walletConfig = registerAs('wallet', () => ({
  maxPayoutAccounts: parseInt(process.env.MAX_PAYOUT_ACCOUNTS || '4', 10),
  codeTtlMinutes: parseInt(
    process.env.PAYOUT_ACCOUNT_CODE_TTL_MINUTES || '15',
    10,
  ),
  /** Six digits falls in seconds unthrottled. */
  maxCodeAttempts: parseInt(
    process.env.PAYOUT_ACCOUNT_MAX_CODE_ATTEMPTS || '5',
    10,
  ),
  resendSeconds: parseInt(
    process.env.PAYOUT_ACCOUNT_RESEND_SECONDS || '60',
    10,
  ),
  /**
   * How long one password confirmation covers further sensitive actions. Per-action
   * re-entry trains vendors into a weak password or a saved one, which protects nothing.
   */
  passwordConfirmationMinutes: parseInt(
    process.env.PASSWORD_CONFIRMATION_TTL_MINUTES || '15',
    10,
  ),
  bankListCacheHours: parseInt(process.env.BANK_LIST_CACHE_HOURS || '24', 10),

  /** Below this a ₦25 fee stops being a rounding error and starts being a tax. */
  minWithdrawalNgn: parseInt(process.env.MIN_WITHDRAWAL_NGN || '2000', 10),
  transferFeeTiers: parseFeeTiers(
    process.env.PAYSTACK_TRANSFER_FEE_TIERS || '5000:10,50000:25,*:50',
  ),
  withdrawalRetryMinutes: parseInt(
    process.env.WITHDRAWAL_RETRY_MINUTES || '30',
    10,
  ),
  /** Roughly four hours of retries at the default interval, then a human looks. */
  withdrawalMaxAttempts: parseInt(
    process.env.WITHDRAWAL_MAX_ATTEMPTS || '8',
    10,
  ),
}));

export interface FeeTier {
  /** Null is the catch-all, and must be last. */
  upTo: number | null;
  fee: number;
}

function parseFeeTiers(raw: string): FeeTier[] {
  const tiers = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [bound, fee] = part.split(':');
      return {
        upTo: bound === '*' ? null : Number(bound),
        fee: Number(fee),
      };
    })
    .filter(
      (tier) =>
        Number.isFinite(tier.fee) &&
        tier.fee >= 0 &&
        (tier.upTo === null || Number.isFinite(tier.upTo)),
    );

  return tiers.length > 0
    ? tiers
    : [
        { upTo: 5000, fee: 10 },
        { upTo: 50000, fee: 25 },
        { upTo: null, fee: 50 },
      ];
}

export const pushConfig = registerAs('push', () => ({
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
  subject: process.env.VAPID_SUBJECT || 'mailto:support@recommend.ng',
}));
