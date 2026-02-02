import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { GoogleAuthController } from './google-auth/google-auth.controller';
import { GoogleAuthService } from './google-auth/google-auth.service';
import { GoogleOAuthStrategy } from './strategies/google-auth.strategy';
import { User } from './entities/auth.entity';
import { RefreshToken } from './entities/refresh-token.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, RefreshToken]),
    PassportModule.register({ defaultStrategy: 'google' }),
    ConfigModule,
    JwtModule,
  ],
  controllers: [GoogleAuthController],
  providers: [GoogleAuthService, GoogleOAuthStrategy],
  exports: [GoogleAuthService],
})
export class GoogleAuthModule {}
