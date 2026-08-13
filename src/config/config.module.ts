import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import configuration, {
  databaseConfig,
  redisConfig,
  jwtConfig,
  whatsappConfig,
  cloudinaryConfig,
  openaiConfig,
  paymentConfig,
  googleConfig,
  deliveryConfig,
  platformConfig,
  walletConfig,
  pushConfig,
  chatConfig,
} from './configuration';
import { validate } from './config.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        configuration,
        databaseConfig,
        redisConfig,
        jwtConfig,
        whatsappConfig,
        cloudinaryConfig,
        openaiConfig,
        paymentConfig,
        googleConfig,
        deliveryConfig,
        platformConfig,
        walletConfig,
        pushConfig,
        chatConfig,
      ],
      validate,
    }),
  ],
  providers: [ConfigService],
  exports: [ConfigService],
})
export class AppConfigModule {}
