import { registerAs } from '@nestjs/config';
import { DataSourceOptions } from 'typeorm';

export default registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  apiPrefix: process.env.API_PREFIX || 'api/v1',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:4000',
  vendorAppUrl: process.env.VENDOR_APP_URL || '',
}));

export const databaseConfig = registerAs('database', () => {
  const entities = [__dirname + '/../**/*.entity{.ts,.js}'];
  const migrations = [__dirname + '/../database/migrations/*{.ts,.js}'];

  const synchronize =
    process.env.NODE_ENV !== 'production' &&
    process.env.DATABASE_SYNCHRONIZE === 'true';

  return {
    type: 'postgres' as const,
    url:
      process.env.DATABASE_URL ||
      'postgresql://postgres:postgres@localhost:5432/recommend_db',
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
export const getTypeOrmConfig = (): DataSourceOptions => {
  const config = databaseConfig();
  return {
    type: config.type,
    url: config.url,
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
  // gpt-4-turbo-preview was retired and now 404s. Discovery is short prompts over
  // small tool results, so the cheapest capable tool-calling model is the right
  // default; move up to gpt-4.1-mini or gpt-4o if reply quality needs it.
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  temperature: parseFloat(process.env.OPENAI_TEMPERATURE || '0.2'),
}));

export const emailConfig = registerAs('email', () => ({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT || '587', 10),
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
  from: process.env.EMAIL_FROM || 'noreply@recommend.ng',
}));

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
}));

export const deliveryConfig = registerAs('delivery', () => ({
  feeNgn: parseInt(process.env.DELIVERY_FEE_NGN || '1500', 10),
}));

export const pushConfig = registerAs('push', () => ({
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
  subject: process.env.VAPID_SUBJECT || 'mailto:support@recommend.ng',
}));
