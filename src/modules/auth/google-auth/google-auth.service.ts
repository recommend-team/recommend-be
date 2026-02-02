import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { User } from '../entities/auth.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import {
  JwtPayload,
  RefreshTokenPayload,
} from '../interfaces/jwt-payload.interface';
import { PassportUser } from '../interfaces/google-profile.interface';
import { Role } from '../../../common/enums/roles.enum';
import { SellerStatus } from '../../../common/enums/seller-status.enum';

export interface GoogleUserInfo {
  email: string;
  firstName: string;
  lastName: string;
  picture?: string;
  googleId: string;
}

@Injectable()
export class GoogleAuthService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokensRepository: Repository<RefreshToken>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Handle Google OAuth callback - exchange code for tokens and user data
   */
  async handleGoogleCallback(googleUser: PassportUser): Promise<{
    accessToken: string;
    refreshToken: string;
    user: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      profilePicture?: string;
      role: Role;
    };
  }> {
    // Try to find user by googleId first
    const existingUser = await this.usersRepository.findOne({
      where: { googleId: googleUser.googleId },
    });

    let user: User;

    if (existingUser) {
      // Update existing user with latest info from Google
      existingUser.firstName = googleUser.firstName;
      existingUser.lastName = googleUser.lastName;
      existingUser.profilePicture =
        googleUser.picture || existingUser.profilePicture;
      user = await this.usersRepository.save(existingUser);
    } else {
      // Check if user exists with this email
      const existingUserByEmail = await this.usersRepository.findOne({
        where: { email: googleUser.email },
      });

      if (existingUserByEmail) {
        // Link Google account to existing user
        existingUserByEmail.googleId = googleUser.googleId;
        existingUserByEmail.firstName = googleUser.firstName;
        existingUserByEmail.lastName = googleUser.lastName;
        existingUserByEmail.profilePicture =
          googleUser.picture || existingUserByEmail.profilePicture;
        user = await this.usersRepository.save(existingUserByEmail);
      } else {
        // Create new user from Google profile
        user = this.usersRepository.create({
          email: googleUser.email,
          firstName: googleUser.firstName,
          lastName: googleUser.lastName,
          phoneNumber: '', // Will be set later via profile update
          profilePicture: googleUser.picture,
          googleId: googleUser.googleId,
          role: Role.SELLER,
          status: SellerStatus.APPROVED, // Auto-approve Google users
          isEmailVerified: true,
          emailVerifiedAt: new Date(),
        });
        user = await this.usersRepository.save(user);
      }
    }

    // Generate tokens directly
    const tokens = await this.generateTokens(user);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        profilePicture: user.profilePicture || undefined,
        role: user.role,
      },
    };
  }

  /**
   * Validate and extract user info from Google profile
   */
  validateGoogleProfile(profile: PassportUser): PassportUser {
    // Profile comes from Passport strategy's validate method, already validated
    if (!profile.email) {
      console.error('Invalid profile structure - missing email:', profile);
      throw new Error('Email not provided by Google');
    }

    if (!profile.googleId) {
      console.error('Invalid profile structure - missing googleId:', profile);
      throw new Error('Google ID not provided');
    }

    return profile;
  }

  /**
   * Generate JWT tokens for a user
   */
  private async generateTokens(user: User): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    const jwtPayload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
    };

    const refreshTokenPayload: RefreshTokenPayload = {
      sub: user.id,
      tokenId: randomBytes(16).toString('hex'),
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(jwtPayload, {
        secret: this.configService.get<string>('jwt.secret'),
        expiresIn: this.configService.get<string>('jwt.expiresIn'),
      }),
      this.jwtService.signAsync(refreshTokenPayload, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
        expiresIn: this.configService.get<string>('jwt.refreshExpiresIn'),
      }),
    ]);

    // Store refresh token in database
    const refreshExpiresIn = this.configService.get<string>(
      'jwt.refreshExpiresIn',
      '7d',
    );
    const days = parseInt(refreshExpiresIn.slice(0, -1), 10);

    const refreshTokenEntity = this.refreshTokensRepository.create({
      token: refreshToken,
      userId: user.id,
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
    });

    await this.refreshTokensRepository.save(refreshTokenEntity);

    return { accessToken, refreshToken };
  }
}
