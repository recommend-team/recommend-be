import { plainToInstance } from 'class-transformer';
import { IsEnum, IsNumber, IsString, validateSync } from 'class-validator';

export enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment;

  @IsNumber()
  PORT: number;

  @IsString()
  API_PREFIX: string;

  @IsString()
  DATABASE_URL: string;

  @IsString()
  REDIS_HOST: string;

  @IsNumber()
  REDIS_PORT: number;

  @IsString()
  REDIS_PASSWORD: string;

  @IsNumber()
  REDIS_TTL: number;

  @IsString()
  JWT_SECRET: string;

  @IsString()
  JWT_EXPIRATION: string;

  @IsString()
  WHATSAPP_API_VERSION: string;

  @IsString()
  WHATSAPP_PHONE_NUMBER_ID: string;

  @IsString()
  WHATSAPP_ACCESS_TOKEN: string;

  @IsString()
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: string;

  @IsString()
  OPENAI_API_KEY: string;

  @IsString()
  OPENAI_MODEL: string;

  @IsNumber()
  OPENAI_MAX_TOKENS: number;

  @IsNumber()
  MAX_RECOMMENDATIONS: number;

  @IsNumber()
  SESSION_TTL: number;
}

export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(errors.toString());
  }
  return validatedConfig;
}