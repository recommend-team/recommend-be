import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes, createHash } from 'crypto';
import { RefreshToken } from './entities/refresh-token.entity';
import { PendingUser } from './entities/pending-user.entity';
import {
  JwtPayload,
  RefreshTokenPayload,
} from './interfaces/jwt-payload.interface';
import { Role } from '../../common/enums/roles.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { User } from './entities/auth.entity';
import { EmailService } from 'src/common/services/email.service';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokensRepository: Repository<RefreshToken>,
    @InjectRepository(PendingUser)
    private readonly pendingUsersRepository: Repository<PendingUser>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {}

  async register(
    registerDto: RegisterDto,
  ): Promise<{ pendingUser: PendingUser; message: string }> {
    // Check if email already exists in users table
    const existingUserByEmail = await this.usersRepository.findOne({
      where: { email: registerDto.email },
    });

    if (existingUserByEmail) {
      throw new ConflictException('Email already registered');
    }

    // Check if phone already exists in users table
    const existingUserByPhone = await this.usersRepository.findOne({
      where: { phoneNumber: registerDto.phoneNumber },
    });

    if (existingUserByPhone) {
      throw new ConflictException('Phone number already registered');
    }

    // Check if email exists in pending_users table
    const existingPendingUserByEmail =
      await this.pendingUsersRepository.findOne({
        where: { email: registerDto.email },
      });

    if (existingPendingUserByEmail) {
      throw new ConflictException('Email is already pending verification');
    }

    // Check if phone exists in pending_users table
    const existingPendingUserByPhone =
      await this.pendingUsersRepository.findOne({
        where: { phoneNumber: registerDto.phoneNumber },
      });

    if (existingPendingUserByPhone) {
      throw new ConflictException(
        'Phone number is already pending verification',
      );
    }

    // Generate 6-digit verification code
    const verificationCode = this.generateSixDigitCode();

    // Create new pending user (temporary) - minimal data only
    const pendingUser = this.pendingUsersRepository.create({
      email: registerDto.email,
      phoneNumber: registerDto.phoneNumber,
      password: registerDto.password,
      firstName: registerDto.firstName,
      lastName: registerDto.lastName,
      verificationCode,
      verificationCodeExpiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
      expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
    });

    await this.pendingUsersRepository.save(pendingUser);

    // Send verification email with 6-digit code
    await this.sendVerificationEmailWithCode(pendingUser, verificationCode);

    return {
      pendingUser,
      message:
        'Registration successful. Please check your email for the 6-digit verification code. You have 5 minutes to verify.',
    };
  }

  async login(loginDto: LoginDto): Promise<{
    accessToken: string;
    refreshToken: string;
    user: User;
  }> {
    // Find user
    const user = await this.usersRepository.findOne({
      where: { email: loginDto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check if user can login
    if (!user.canLogin()) {
      throw new UnauthorizedException(
        'Account is suspended, deactivated, or has too many failed login attempts',
      );
    }

    // Validate password
    const isPasswordValid = await user.validatePassword(loginDto.password);
    if (!isPasswordValid) {
      user.recordFailedLogin();
      await this.usersRepository.save(user);
      throw new UnauthorizedException('Invalid credentials');
    }

    // Record successful login
    user.recordSuccessfulLogin();
    await this.usersRepository.save(user);

    // Generate tokens
    const tokens = await this.generateTokens(user);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user,
    };
  }

  async refreshTokens(refreshTokenDto: RefreshTokenDto): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    try {
      // Verify refresh token
      const payload = this.jwtService.verify<RefreshTokenPayload>(
        refreshTokenDto.refreshToken,
        {
          secret: this.configService.get<string>('jwt.refreshSecret'),
        },
      );

      // Find the refresh token in database
      const storedToken = await this.refreshTokensRepository.findOne({
        where: { token: refreshTokenDto.refreshToken, userId: payload.sub },
        relations: ['user'],
      });

      if (!storedToken || !storedToken.isValid()) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      // Revoke the old token
      storedToken.isRevoked = true;
      storedToken.revokedAt = new Date();
      await this.refreshTokensRepository.save(storedToken);

      // Generate new tokens
      return this.generateTokens(storedToken.user);
    } catch (error) {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async verifyEmail(
    verifyEmailDto: VerifyEmailDto,
  ): Promise<{ message: string; user: User }> {
    // Find pending user by email and verification code
    const pendingUser = await this.pendingUsersRepository.findOne({
      where: {
        email: verifyEmailDto.email,
        verificationCode: verifyEmailDto.code,
      },
    });

    if (!pendingUser) {
      throw new NotFoundException('Invalid email or verification code');
    }

    // Check if verification code is expired
    if (new Date() > pendingUser.verificationCodeExpiresAt) {
      // Delete expired pending user
      await this.pendingUsersRepository.remove(pendingUser);
      throw new BadRequestException(
        'Verification code has expired. Please register again.',
      );
    }

    // Move user from pending_users to users table
    const newUser = this.usersRepository.create({
      email: pendingUser.email,
      password: pendingUser.password,
      firstName: pendingUser.firstName,
      lastName: pendingUser.lastName,
      phoneNumber: pendingUser.phoneNumber,
      role: Role.SELLER,
      status: SellerStatus.APPROVED,
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    });

    const savedUser = await this.usersRepository.save(newUser);

    // Delete pending user
    await this.pendingUsersRepository.remove(pendingUser);

    return {
      message:
        'Email verified successfully. You can now log in to your account.',
      user: savedUser,
    };
  }

  async resendVerificationEmail(email: string): Promise<{ message: string }> {
    const user = await this.usersRepository.findOne({ where: { email } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.isEmailVerified) {
      throw new BadRequestException('Email is already verified');
    }

    // Generate new verification token
    user.emailVerificationToken = this.generateEmailVerificationToken();
    user.emailVerificationTokenExpires = new Date(
      Date.now() + 24 * 60 * 60 * 1000,
    );

    await this.usersRepository.save(user);
    await this.sendVerificationEmail(user);

    return {
      message: 'Verification email sent successfully',
    };
  }

  async forgotPassword(email: string): Promise<{ message: string }> {
    const user = await this.usersRepository.findOne({ where: { email } });

    if (!user) {
      // Don't reveal that user doesn't exist
      return {
        message:
          'If an account exists with this email, you will receive a password reset link',
      };
    }

    // Generate reset token
    const resetToken = this.generateResetToken();
    user.passwordResetToken = createHash('sha256')
      .update(resetToken)
      .digest('hex');
    user.passwordResetTokenExpires = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1 hour

    await this.usersRepository.save(user);

    // Send reset email
    await this.sendPasswordResetEmail(user, resetToken);

    return {
      message:
        'If an account exists with this email, you will receive a password reset link',
    };
  }

  async resetPassword(
    resetPasswordDto: ResetPasswordDto,
  ): Promise<{ message: string }> {
    // Hash the token to compare with stored hash
    const hashedToken = createHash('sha256')
      .update(resetPasswordDto.token)
      .digest('hex');

    const user = await this.usersRepository.findOne({
      where: { passwordResetToken: hashedToken },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    // Check if token is expired
    if (
      user.passwordResetTokenExpires &&
      new Date() > user.passwordResetTokenExpires
    ) {
      throw new BadRequestException('Reset token has expired');
    }

    // Update password
    user.password = resetPasswordDto.password;
    user.passwordResetToken = null;
    user.passwordResetTokenExpires = null;
    user.passwordChangedAt = new Date();

    await this.usersRepository.save(user);

    // Send password changed notification
    await this.sendPasswordChangedEmail(user);

    return {
      message:
        'Password reset successfully. You can now log in with your new password.',
    };
  }

  async logout(userId: string, refreshToken?: string): Promise<void> {
    // Revoke specific refresh token if provided
    if (refreshToken) {
      const storedToken = await this.refreshTokensRepository.findOne({
        where: { token: refreshToken, userId },
      });

      if (storedToken) {
        storedToken.isRevoked = true;
        storedToken.revokedAt = new Date();
        await this.refreshTokensRepository.save(storedToken);
      }
    }

    // Revoke all refresh tokens for this user
    await this.refreshTokensRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true, revokedAt: new Date() },
    );
  }

  async validateUser(payload: JwtPayload): Promise<User | null> {
    const user = await this.usersRepository.findOne({
      where: { id: payload.sub },
    });
    if (!user || !user.isActive()) {
      return null;
    }
    return user;
  }

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

  private generateEmailVerificationToken(): string {
    return randomBytes(32).toString('hex');
  }

  private generateResetToken(): string {
    return randomBytes(32).toString('hex');
  }

  private async sendVerificationEmail(user: User): Promise<void> {
    const verificationUrl = `${this.configService.get('app.frontendUrl')}/verify-email?token=${user.emailVerificationToken}`;

    try {
      await this.emailService.sendEmail({
        to: user.email,
        subject: 'Verify your email address',
        template: 'email-verification',
        context: {
          name: user.firstName || 'Seller',
          verificationUrl,
        },
      });
    } catch (error) {
      console.error('Failed to send verification email:', error);
      // Don't throw error to user, just log it
    }
  }

  private async sendPasswordResetEmail(
    user: User,
    resetToken: string,
  ): Promise<void> {
    const resetUrl = `${this.configService.get('app.frontendUrl')}/reset-password?token=${resetToken}`;

    try {
      await this.emailService.sendEmail({
        to: user.email,
        subject: 'Reset your password',
        template: 'password-reset',
        context: {
          name: user.firstName || 'Seller',
          resetUrl,
        },
      });
    } catch (error) {
      console.error('Failed to send reset email:', error);
    }
  }

  private async sendPasswordChangedEmail(user: User): Promise<void> {
    try {
      await this.emailService.sendEmail({
        to: user.email,
        subject: 'Password changed successfully',
        template: 'password-changed',
        context: {
          name: user.firstName || 'Seller',
          timestamp: new Date().toLocaleString(),
        },
      });
    } catch (error) {
      console.error('Failed to send password changed email:', error);
    }
  }

  private generateSixDigitCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private async sendVerificationEmailWithCode(
    pendingUser: PendingUser,
    code: string,
  ): Promise<void> {
    try {
      await this.emailService.sendEmail({
        to: pendingUser.email,
        subject: 'Verify your email address',
        template: 'email-verification-code',
        context: {
          name: pendingUser.firstName || 'Seller',
          code,
        },
      });
    } catch (error) {
      console.error('Failed to send verification email:', error);
      // Don't throw error to user, just log it
    }
  }
}
