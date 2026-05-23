import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Get,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { ZodValidationPipe } from 'src/common/pipes/zod-validation.pipes';
import { LoginRequestDto, loginSchema } from './dto/login.dto';
import {
  RefreshTokenRequestDto,
  refreshTokenSchema,
} from './dto/refresh-token.dto';
import { RegisterRequestDto, registerSchema } from './dto/register.dto';
import {
  ResetPasswordRequestDto,
  resetPasswordSchema,
} from './dto/reset-password.dto';
import {
  VerifyEmailRequestDto,
  verifyEmailSchema,
} from './dto/verify-email.dto';
import {
  RegisterVendorRequestDto,
  registerVendorSchema,
} from './dto/register-vendor.dto';
import {
  RegisterRiderRequestDto,
  registerRiderSchema,
} from './dto/register-rider.dto';
import { User } from './entities/auth.entity';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ─── Vendor registration ───────────────────────────────────────────────────

  @Public()
  @Post('register/vendor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a vendor',
    description:
      'Register as a vendor (seller). vendorType REGISTERED = has CAC/TIN (unlimited orders). NON_REGISTERED = informal vendor (20 orders/month cap). Vendors can log in and access their dashboard immediately after verifying email; admin KYC approval is required before products can be listed.',
  })
  @ApiBody({ type: RegisterVendorRequestDto })
  @ApiResponse({
    status: 201,
    description: 'Registration successful — verification code sent to email',
  })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({
    status: 409,
    description: 'Email or phone already registered',
  })
  async registerVendor(
    @Body(new ZodValidationPipe(registerVendorSchema))
    dto: RegisterVendorRequestDto,
  ) {
    return this.authService.registerVendor(dto);
  }

  // ─── Rider registration ────────────────────────────────────────────────────

  @Public()
  @Post('register/rider')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a rider',
    description:
      'Register as a delivery rider. riderType: INDIVIDUAL or COMPANY. Riders can log in and access their dashboard immediately after verifying email; admin KYC approval is required before they can accept deliveries.',
  })
  @ApiBody({ type: RegisterRiderRequestDto })
  @ApiResponse({
    status: 201,
    description: 'Registration successful — verification code sent to email',
  })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({
    status: 409,
    description: 'Email or phone already registered',
  })
  async registerRider(
    @Body(new ZodValidationPipe(registerRiderSchema))
    dto: RegisterRiderRequestDto,
  ) {
    return this.authService.registerRider(dto);
  }

  // ─── Legacy register (vendor, backwards-compatible) ────────────────────────

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a vendor (legacy)',
    description:
      'Backwards-compatible endpoint. Prefer POST /auth/register/vendor.',
    deprecated: true,
  })
  @ApiBody({ type: RegisterRequestDto })
  @ApiResponse({ status: 201, description: 'Registration successful' })
  async register(
    @Body(new ZodValidationPipe(registerSchema))
    registerDto: RegisterRequestDto,
  ) {
    return this.authService.register(registerDto);
  }

  // ─── Login ─────────────────────────────────────────────────────────────────

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login' })
  @ApiBody({ type: LoginRequestDto })
  @ApiResponse({
    status: 200,
    description:
      'Login successful — returns access token, refresh token, and user profile',
  })
  @ApiResponse({
    status: 401,
    description:
      'Invalid credentials / email not verified / account suspended or deactivated',
  })
  async login(
    @Body(new ZodValidationPipe(loginSchema)) loginDto: LoginRequestDto,
  ) {
    return this.authService.login(loginDto);
  }

  // ─── Token refresh ─────────────────────────────────────────────────────────

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiBody({ type: RefreshTokenRequestDto })
  @ApiResponse({
    status: 200,
    description: 'New access token and refresh token issued',
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refreshTokens(
    @Body(new ZodValidationPipe(refreshTokenSchema))
    refreshTokenDto: RefreshTokenRequestDto,
  ) {
    return this.authService.refreshTokens(refreshTokenDto);
  }

  // ─── Email verification ────────────────────────────────────────────────────

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email with 6-digit code' })
  @ApiBody({ type: VerifyEmailRequestDto })
  @ApiResponse({
    status: 200,
    description:
      'Email verified. Vendors/riders can now log in. KYC approval is still required before listing products or accepting deliveries.',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid or expired verification code',
  })
  async verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailSchema))
    verifyEmailDto: VerifyEmailRequestDto,
  ) {
    return this.authService.verifyEmail(verifyEmailDto);
  }

  @Public()
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend email verification code' })
  @ApiResponse({ status: 200, description: 'Verification code resent' })
  @ApiResponse({ status: 404, description: 'No pending registration found' })
  async resendVerificationEmail(@Body('email') email: string) {
    return this.authService.resendVerificationEmail(email);
  }

  // ─── Password management ───────────────────────────────────────────────────

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset link' })
  @ApiResponse({
    status: 200,
    description:
      'Reset email sent if account exists (always returns 200 to prevent enumeration)',
  })
  async forgotPassword(@Body('email') email: string) {
    return this.authService.forgotPassword(email);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using token from email' })
  @ApiBody({ type: ResetPasswordRequestDto })
  @ApiResponse({ status: 200, description: 'Password reset successful' })
  @ApiResponse({ status: 400, description: 'Invalid or expired reset token' })
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema))
    resetPasswordDto: ResetPasswordRequestDto,
  ) {
    return this.authService.resetPassword(resetPasswordDto);
  }

  // ─── Authenticated endpoints ───────────────────────────────────────────────

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Logout — revokes all refresh tokens for this user',
  })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async logout(
    @CurrentUser() user: User,
    @Body('refreshToken') refreshToken?: string,
  ) {
    return this.authService.logout(user.id, refreshToken);
  }

  @Get('profile')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated user profile' })
  @ApiResponse({ status: 200, description: 'User profile' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getProfile(@CurrentUser() user: User) {
    return this.authService.getProfile(user.id);
  }
}
