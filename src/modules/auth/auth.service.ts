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
import { VendorType } from '../../common/enums/vendor-type.enum';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { RegisterVendorDto } from './dto/register-vendor.dto';
import { RegisterRiderDto } from './dto/register-rider.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { User } from './entities/auth.entity';
import { EmailService } from 'src/common/services/email.service';

/** Safe user shape returned to frontend — no passwords or secret tokens */
export type SafeUser = Omit<
  User,
  | 'password'
  | 'emailVerificationToken'
  | 'emailVerificationTokenExpires'
  | 'passwordResetToken'
  | 'passwordResetTokenExpires'
  | 'hashPassword'
  | 'validatePassword'
  | 'isActive'
  | 'isApproved'
  | 'isPendingApproval'
  | 'canLogin'
  | 'recordFailedLogin'
  | 'recordSuccessfulLogin'
>;

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

  // ─── Registration ──────────────────────────────────────────────────────────

  /**
   * Backwards-compatible entry point — registers as a REGISTERED vendor.
   */
  async register(
    registerDto: RegisterDto,
  ): Promise<{ message: string; data: { email: string } }> {
    return this.registerVendor({
      ...registerDto,
      vendorType: VendorType.REGISTERED,
      businessName: '',
      businessAddress: '',
      businessCategory: '',
    });
  }

  async registerVendor(
    dto: RegisterVendorDto,
  ): Promise<{ message: string; data: { email: string } }> {
    await this.assertEmailAndPhoneAvailable(dto.email, dto.phoneNumber);

    const verificationCode = this.generateSixDigitCode();

    const pendingUser = this.pendingUsersRepository.create({
      email: dto.email,
      phoneNumber: dto.phoneNumber,
      password: dto.password,
      firstName: dto.firstName,
      lastName: dto.lastName,
      role: Role.SELLER,
      vendorType: dto.vendorType,
      riderType: null,
      verificationCode,
      verificationCodeExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    await this.pendingUsersRepository.save(pendingUser);
    await this.sendVerificationEmailWithCode(pendingUser, verificationCode);

    return {
      message:
        'Registration successful. Please check your email for the 6-digit verification code. You have 5 minutes to verify.',
      data: { email: dto.email },
    };
  }

  async registerRider(
    dto: RegisterRiderDto,
  ): Promise<{ message: string; data: { email: string } }> {
    await this.assertEmailAndPhoneAvailable(dto.email, dto.phoneNumber);

    const verificationCode = this.generateSixDigitCode();

    const pendingUser = this.pendingUsersRepository.create({
      email: dto.email,
      phoneNumber: dto.phoneNumber,
      password: dto.password,
      firstName: dto.firstName,
      lastName: dto.lastName,
      role: Role.RIDER,
      vendorType: null,
      riderType: dto.riderType,
      verificationCode,
      verificationCodeExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    await this.pendingUsersRepository.save(pendingUser);
    await this.sendVerificationEmailWithCode(pendingUser, verificationCode);

    return {
      message:
        'Rider registration successful. Please check your email for the 6-digit verification code. You have 5 minutes to verify.',
      data: { email: dto.email },
    };
  }

  // ─── Login ─────────────────────────────────────────────────────────────────

  async login(loginDto: LoginDto): Promise<{
    message: string;
    data: { accessToken: string; refreshToken: string; user: SafeUser };
  }> {
    const user = await this.usersRepository.findOne({
      where: { email: loginDto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.isEmailVerified) {
      throw new UnauthorizedException(
        'Please verify your email address before logging in.',
      );
    }

    if (user.status === SellerStatus.SUSPENDED) {
      throw new UnauthorizedException(
        'Your account has been suspended. Please contact support.',
      );
    }

    if (user.status === SellerStatus.DEACTIVATED) {
      throw new UnauthorizedException(
        'Your account has been deactivated. Please contact support.',
      );
    }

    if (user.failedLoginAttempts >= 5) {
      throw new UnauthorizedException(
        'Account locked due to too many failed login attempts. Please reset your password.',
      );
    }

    const isPasswordValid = await user.validatePassword(loginDto.password);
    if (!isPasswordValid) {
      user.recordFailedLogin();
      await this.usersRepository.save(user);
      throw new UnauthorizedException('Invalid email or password');
    }

    user.recordSuccessfulLogin();
    await this.usersRepository.save(user);

    const tokens = await this.generateTokens(user);

    return {
      message: 'Login successful',
      data: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: this.sanitizeUser(user),
      },
    };
  }

  // ─── Token refresh ─────────────────────────────────────────────────────────

  async refreshTokens(refreshTokenDto: RefreshTokenDto): Promise<{
    message: string;
    data: { accessToken: string; refreshToken: string };
  }> {
    try {
      const payload = this.jwtService.verify<RefreshTokenPayload>(
        refreshTokenDto.refreshToken,
        {
          secret: this.configService.get<string>('jwt.refreshSecret'),
        },
      );

      const storedToken = await this.refreshTokensRepository.findOne({
        where: { token: refreshTokenDto.refreshToken, userId: payload.sub },
        relations: ['user'],
      });

      if (!storedToken || !storedToken.isValid()) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      storedToken.isRevoked = true;
      storedToken.revokedAt = new Date();
      await this.refreshTokensRepository.save(storedToken);

      const tokens = await this.generateTokens(storedToken.user);

      return { message: 'Tokens refreshed successfully', data: tokens };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  // ─── Email verification ────────────────────────────────────────────────────

  async verifyEmail(
    verifyEmailDto: VerifyEmailDto,
  ): Promise<{ message: string; data: { user: SafeUser } }> {
    const pendingUser = await this.pendingUsersRepository.findOne({
      where: {
        email: verifyEmailDto.email,
        verificationCode: verifyEmailDto.code,
      },
    });

    if (!pendingUser) {
      throw new BadRequestException('Invalid email or verification code');
    }

    if (new Date() > pendingUser.verificationCodeExpiresAt) {
      await this.pendingUsersRepository.remove(pendingUser);
      throw new BadRequestException(
        'Verification code has expired. Please register again.',
      );
    }

    // BUYER → auto-approved (bot-created); SELLER / RIDER → await admin KYC review
    const status =
      pendingUser.role === Role.BUYER
        ? SellerStatus.APPROVED
        : SellerStatus.PENDING;

    const orderQuota =
      pendingUser.role === Role.SELLER &&
      pendingUser.vendorType === VendorType.NON_REGISTERED
        ? 20
        : null;

    const newUser = this.usersRepository.create({
      email: pendingUser.email,
      password: pendingUser.password,
      firstName: pendingUser.firstName,
      lastName: pendingUser.lastName,
      phoneNumber: pendingUser.phoneNumber,
      role: pendingUser.role,
      vendorType: pendingUser.vendorType,
      riderType: pendingUser.riderType,
      orderQuota,
      status,
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    });

    const savedUser = await this.usersRepository.save(newUser);
    await this.pendingUsersRepository.remove(pendingUser);

    const awaitingApproval = status === SellerStatus.PENDING;

    return {
      message: awaitingApproval
        ? 'Email verified. You can now log in and access your dashboard. KYC approval is required before you can list products or accept deliveries.'
        : 'Email verified successfully. You can now log in.',
      data: { user: this.sanitizeUser(savedUser) },
    };
  }

  async resendVerificationEmail(
    email: string,
  ): Promise<{ message: string; data: null }> {
    const pendingUser = await this.pendingUsersRepository.findOne({
      where: { email },
    });

    if (!pendingUser) {
      const user = await this.usersRepository.findOne({ where: { email } });
      if (user?.isEmailVerified) {
        throw new BadRequestException('Email is already verified');
      }
      throw new NotFoundException(
        'No pending registration found for this email. Please register first.',
      );
    }

    const verificationCode = this.generateSixDigitCode();
    pendingUser.verificationCode = verificationCode;
    pendingUser.verificationCodeExpiresAt = new Date(
      Date.now() + 5 * 60 * 1000,
    );
    pendingUser.expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await this.pendingUsersRepository.save(pendingUser);
    await this.sendVerificationEmailWithCode(pendingUser, verificationCode);

    return {
      message: 'Verification code resent. Please check your email.',
      data: null,
    };
  }

  // ─── Password management ───────────────────────────────────────────────────

  async forgotPassword(
    email: string,
  ): Promise<{ message: string; data: null }> {
    const genericMessage =
      'If an account exists with this email, you will receive a password reset link shortly.';

    const user = await this.usersRepository.findOne({ where: { email } });
    if (!user) return { message: genericMessage, data: null };

    const resetToken = this.generateResetToken();
    user.passwordResetToken = createHash('sha256')
      .update(resetToken)
      .digest('hex');
    user.passwordResetTokenExpires = new Date(Date.now() + 60 * 60 * 1000);

    await this.usersRepository.save(user);
    await this.sendPasswordResetEmail(user, resetToken);

    return { message: genericMessage, data: null };
  }

  async resetPassword(
    resetPasswordDto: ResetPasswordDto,
  ): Promise<{ message: string; data: null }> {
    const hashedToken = createHash('sha256')
      .update(resetPasswordDto.token)
      .digest('hex');

    const user = await this.usersRepository.findOne({
      where: { passwordResetToken: hashedToken },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    if (
      user.passwordResetTokenExpires &&
      new Date() > user.passwordResetTokenExpires
    ) {
      throw new BadRequestException(
        'Reset token has expired. Please request a new password reset.',
      );
    }

    user.password = resetPasswordDto.password;
    user.passwordResetToken = null;
    user.passwordResetTokenExpires = null;
    user.passwordChangedAt = new Date();

    await this.usersRepository.save(user);
    await this.sendPasswordChangedEmail(user);

    return {
      message:
        'Password reset successfully. You can now log in with your new password.',
      data: null,
    };
  }

  // ─── Logout ────────────────────────────────────────────────────────────────

  async logout(
    userId: string,
    refreshToken?: string,
  ): Promise<{ message: string; data: null }> {
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

    await this.refreshTokensRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true, revokedAt: new Date() },
    );

    return { message: 'Logged out successfully', data: null };
  }

  // ─── Profile ───────────────────────────────────────────────────────────────

  async getProfile(
    userId: string,
  ): Promise<{ message: string; data: SafeUser }> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return {
      message: 'Profile retrieved successfully',
      data: this.sanitizeUser(user),
    };
  }

  // ─── JWT validation ────────────────────────────────────────────────────────

  async validateUser(payload: JwtPayload): Promise<User | null> {
    const user = await this.usersRepository.findOne({
      where: { id: payload.sub },
    });
    if (!user || !user.isActive()) return null;
    return user;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async assertEmailAndPhoneAvailable(
    email: string,
    phoneNumber: string,
  ): Promise<void> {
    const [userByEmail, userByPhone, pendingByEmail, pendingByPhone] =
      await Promise.all([
        this.usersRepository.findOne({ where: { email } }),
        this.usersRepository.findOne({ where: { phoneNumber } }),
        this.pendingUsersRepository.findOne({ where: { email } }),
        this.pendingUsersRepository.findOne({ where: { phoneNumber } }),
      ]);

    if (userByEmail) throw new ConflictException('Email is already registered');
    if (userByPhone)
      throw new ConflictException('Phone number is already registered');
    if (pendingByEmail)
      throw new ConflictException('Email is already pending verification');
    if (pendingByPhone)
      throw new ConflictException(
        'Phone number is already pending verification',
      );
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

    const refreshExpiresIn = this.configService.get<string>(
      'jwt.refreshExpiresIn',
      '30d',
    );
    const days = parseInt(refreshExpiresIn.replace(/\D/g, ''), 10) || 30;

    await this.refreshTokensRepository.save(
      this.refreshTokensRepository.create({
        token: refreshToken,
        userId: user.id,
        expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
      }),
    );

    return { accessToken, refreshToken };
  }

  sanitizeUser(user: User): SafeUser {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {
      password,
      emailVerificationToken,
      emailVerificationTokenExpires,
      passwordResetToken,
      passwordResetTokenExpires,
      ...safe
    } = user;

    void password;
    void emailVerificationToken;
    void emailVerificationTokenExpires;
    void passwordResetToken;
    void passwordResetTokenExpires;

    return safe as SafeUser;
  }

  private generateSixDigitCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private generateResetToken(): string {
    return randomBytes(32).toString('hex');
  }

  private async sendVerificationEmailWithCode(
    pendingUser: PendingUser,
    code: string,
  ): Promise<void> {
    try {
      await this.emailService.sendEmail({
        to: pendingUser.email,
        subject: 'Verify your email – Recommend',
        template: 'email-verification-code',
        context: { name: pendingUser.firstName, code, role: pendingUser.role },
      });
    } catch (error) {
      console.error('Failed to send verification email:', error);
    }
  }

  private async sendPasswordResetEmail(
    user: User,
    resetToken: string,
  ): Promise<void> {
    // Vendors live in the vendor app; everyone else resets on the web frontend.
    const vendorAppUrl = this.configService.get<string>('app.vendorAppUrl');
    const base =
      user.role === Role.SELLER && vendorAppUrl
        ? vendorAppUrl
        : this.configService.get<string>('app.frontendUrl');
    const resetUrl = `${base}/reset-password?token=${resetToken}`;
    try {
      await this.emailService.sendEmail({
        to: user.email,
        subject: 'Reset your password – Recommend',
        template: 'password-reset',
        context: { name: user.firstName, resetUrl },
      });
    } catch (error) {
      console.error('Failed to send reset email:', error);
    }
  }

  private async sendPasswordChangedEmail(user: User): Promise<void> {
    try {
      await this.emailService.sendEmail({
        to: user.email,
        subject: 'Your password was changed – Recommend',
        template: 'password-changed',
        context: {
          name: user.firstName,
          timestamp: new Date().toLocaleString('en-NG', {
            timeZone: 'Africa/Lagos',
          }),
        },
      });
    } catch (error) {
      console.error('Failed to send password changed email:', error);
    }
  }
}
