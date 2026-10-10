import { registerAs } from '@nestjs/config';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

export default registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  apiPrefix: process.env.API_PREFIX || 'api/v1',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:4000',
  vendorAppUrl: process.env.VENDOR_APP_URL || '',
}));

/**
 * TLS settings in the URL that `pg` would apply *over* the `ssl` option below — the driver
 * merges URL parameters on top of it, so leaving any of these in silently brings back
 * full verification against the system CAs, and the "self-signed certificate" error.
 */
const URL_TLS_PARAMS = [
  'sslmode',
  'ssl',
  'sslrootcert',
  'sslcert',
  'sslkey',
  'uselibpqcompat',
];

const stripSslMode = (url: string): string => {
  try {
    const parsed = new URL(url);
    for (const param of URL_TLS_PARAMS) parsed.searchParams.delete(param);
    return parsed.toString();
  } catch {
    return url;
  }
};

/**
 * A provider's CA certificate (PEM), from `DATABASE_CA_CERT`.
 *
 * Accepted as real multi-line text or with literal `\n` escapes — a single-line value is
 * what most hosting dashboards and `.env` files end up holding. Refused loudly if it is
 * not a certificate: a typo here would otherwise surface as the very TLS error it fixes.
 */
export function readCaCert(raw: string | undefined): string | null {
  const value = raw?.trim().replace(/\\n/g, '\n');
  if (!value) return null;
  if (!value.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(
      'DATABASE_CA_CERT is set but is not a PEM certificate — paste the whole ' +
        'certificate, from -----BEGIN CERTIFICATE----- to -----END CERTIFICATE-----.',
    );
  }
  return value;
}

/** How the app trusts a managed Postgres. See DATABASE_CA_CERT in .env.example. */
export type DatabaseTls =
  | { ca: string; rejectUnauthorized: true }
  | { rejectUnauthorized: false }
  | undefined;

export const databaseConfig = registerAs('database', () => {
  const entities = [__dirname + '/../**/*.entity{.ts,.js}'];
  const migrations = [__dirname + '/../database/migrations/*{.ts,.js}'];

  const synchronize =
    process.env.NODE_ENV !== 'production' &&
    process.env.DATABASE_SYNCHRONIZE === 'true';

  // Preferred: trust the provider's own CA, with full verification. Fallback: encrypt but
  // skip the chain check (DATABASE_SSL=true). Neither: plain connection, for a local DB.
  const ca = readCaCert(process.env.DATABASE_CA_CERT);
  const relaxTls = !ca && process.env.DATABASE_SSL === 'true';
  const ssl: DatabaseTls = ca
    ? { ca, rejectUnauthorized: true }
    : relaxTls
      ? { rejectUnauthorized: false }
      : undefined;

  const url =
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/recommend_db';

  return {
    type: 'postgres' as const,
    url: ssl ? stripSslMode(url) : url,
    ssl,
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
  /**
   * 0.6: enough variety to sound like a person rather than a form letter. Safe to raise —
   * prices never come from the model's words (price-guard.ts drops any it invents), and
   * everything that leads to a charge is scripted.
   */
  temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.6'),
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
  /** What the assistant calls itself — in the greeting and in the model's persona. */
  assistantName: process.env.ASSISTANT_NAME?.trim() || 'James',
  sessionSecret: process.env.CHAT_SESSION_SECRET,
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
  /**
   * How long a handover waits for an admin before the buyer is told, once, that the team
   * is busy. The assistant keeps answering throughout; this only sets expectations.
   */
  handoverNoticeMinutes: parseInt(
    process.env.CHAT_HANDOVER_NOTICE_MINUTES || '3',
    10,
  ),
}));

export const contactConfig = registerAs('contact', () => ({
  inbox: process.env.CONTACT_INBOX || 'contacts.recommend@gmail.com',
  maxPerSenderPerHour: parseInt(
    process.env.CONTACT_MAX_PER_SENDER_PER_HOUR || '5',
    10,
  ),
  maxPerHour: parseInt(process.env.CONTACT_MAX_PER_HOUR || '60', 10),
}));

/**
 * Where the welcome email points people, and where its logo is served from.
 *
 * The logo is a PNG on the public website (`/email/recommend-logo.png`): email clients
 * will not show SVG. An unset app URL falls back to the website, so a button never leads
 * nowhere.
 */
export const brandConfig = registerAs('brand', () => {
  const websiteUrl = (
    process.env.WEBSITE_URL || 'https://recommend-fe.netlify.app'
  ).replace(/\/$/, '');
  return {
    websiteUrl,
    customerAppUrl: (process.env.CUSTOMER_APP_URL || websiteUrl).replace(
      /\/$/,
      '',
    ),
    vendorAppUrl: (process.env.VENDOR_APP_URL || websiteUrl).replace(/\/$/, ''),
  };
});

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
