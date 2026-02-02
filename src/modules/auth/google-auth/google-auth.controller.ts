import {
  Controller,
  Get,
  UseGuards,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { GoogleOAuthGuard } from '../guards/google-oauth.guard';
import { GoogleAuthService } from './google-auth.service';
import { Public } from '../decorators/public.decorator';
import { PassportUser } from '../interfaces/google-profile.interface';

@ApiTags('Authentication - Google OAuth')
@Controller('auth/google')
export class GoogleAuthController {
  constructor(
    private readonly googleAuthService: GoogleAuthService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Initiate Google OAuth - Returns the Google auth URL
   */
  @Public()
  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get Google OAuth authentication URL' })
  @ApiResponse({
    status: 200,
    description: 'Google OAuth URL generated successfully',
    schema: {
      example: {
        status: 'success',
        google_auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?...',
        message: 'Use this URL to authenticate with Google',
        instructions: [
          'Click the link to authenticate with Google',
          'You will be redirected to Google login',
          'After authentication, you will be redirected back with your access token',
        ],
      },
    },
  })
  initiateGoogleAuth() {
    try {
      // Generate Google OAuth URL
      const authUrl = this.generateGoogleAuthUrl();

      return {
        status: 'success',
        google_auth_url: authUrl,
        message: 'Use this URL to authenticate with Google',
        instructions: [
          'Click the link to authenticate with Google',
          'You will be redirected to Google login',
          'After authentication, you will be redirected back with your access token',
        ],
      };
    } catch (error) {
      return {
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Failed to generate authentication URL',
      };
    }
  }

  /**
   * Google OAuth callback handler
   */
  @Public()
  @Get('callback')
  @UseGuards(GoogleOAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Google OAuth callback handler' })
  @ApiResponse({
    status: 200,
    description: 'Authentication successful',
    schema: {
      example: {
        status: 'success',
        access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        refresh_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        token_type: 'Bearer',
        user: {
          id: 'uuid',
          email: 'user@example.com',
          firstName: 'John',
          lastName: 'Doe',
          profilePicture: 'https://example.com/photo.jpg',
          role: 'SELLER',
        },
        message: 'Authentication successful',
      },
    },
  })
  async googleAuthCallback(
    @Req() req: Request & { user?: PassportUser },
    @Res() res: Response,
  ): Promise<void> {
    try {
      const googleProfile = req.user;

      if (!googleProfile) {
        throw new BadRequestException('Google profile not found');
      }

      // Validate and extract user info from Google profile
      const googleUser =
        this.googleAuthService.validateGoogleProfile(googleProfile);

      // Handle Google callback - create/update user and generate tokens
      const result =
        await this.googleAuthService.handleGoogleCallback(googleUser);

      // Return tokens and user info as JSON
      const response = {
        status: 'success',
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        token_type: 'Bearer',
        user: {
          id: result.user.id,
          email: result.user.email,
          firstName: result.user.firstName,
          lastName: result.user.lastName,
          profilePicture: result.user.profilePicture,
          role: result.user.role,
        },
        message: 'Authentication successful',
      };

      res.json(response);
    } catch (error) {
      console.error('Google OAuth callback error:', error);
      const statusCode =
        error instanceof Error && error.message.includes('Invalid')
          ? HttpStatus.BAD_REQUEST
          : HttpStatus.INTERNAL_SERVER_ERROR;

      res.status(statusCode).json({
        status: 'error',
        message:
          error instanceof Error ? error.message : 'Authentication failed',
      });
    }
  }

  /**
   * Generate Google OAuth URL
   */
  private generateGoogleAuthUrl(): string {
    const clientId = this.configService.get<string>('google.clientId');
    const redirectUri = this.configService.get<string>('google.callbackUrl');
    const scopes = ['email', 'profile'];

    const params = new URLSearchParams({
      client_id: clientId || '',
      redirect_uri: redirectUri || '',
      response_type: 'code',
      scope: scopes
        .map((s) => `https://www.googleapis.com/auth/userinfo.${s}`)
        .join(' '),
      access_type: 'offline',
      prompt: 'consent',
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }
}
