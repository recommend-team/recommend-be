import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RefreshToken } from './entities/refresh-token.entity';
import { PendingUser } from './entities/pending-user.entity';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { EmailService } from '../../common/services/email.service';
import { User } from './entities/auth.entity';
import { PendingUserCleanupProcessor } from './processors/pending-user-cleanup.processor';
import { GoogleAuthModule } from './google-auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, RefreshToken, PendingUser]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.secret'),
        signOptions: {
          expiresIn: configService.get<string>('jwt.expiresIn'),
        },
      }),
    }),
    BullModule.registerQueue({
      name: 'pending-user-cleanup',
    }),
    GoogleAuthModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    JwtRefreshStrategy,
    EmailService,
    PendingUserCleanupProcessor,
  ],
  exports: [AuthService, JwtStrategy, PassportModule],
})
export class AuthModule {}
