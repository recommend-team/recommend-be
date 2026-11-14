import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import {
  GoogleProfile,
  PassportUser,
} from '../interfaces/google-profile.interface';

@Injectable()
export class GoogleOAuthStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(private readonly configService: ConfigService) {
    const clientId = configService.get<string>('google.clientId');
    const clientSecret = configService.get<string>('google.clientSecret');
    const callbackUrl = configService.get<string>('google.callbackUrl');

    super({
      clientID: clientId,
      clientSecret: clientSecret,
      callbackURL: callbackUrl,
      scope: ['email', 'profile'],
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  validate(
    accessToken: string,
    refreshToken: string,
    profile: GoogleProfile,
    done: VerifyCallback,
  ): void {
    try {
      const { name, emails, photos } = profile;

      if (!emails || !emails.length) {
        // The profile's id only — not the profile, which is someone's name and photos.
        console.error(`Google profile ${profile.id} has no email`);
        return done(new Error('Email not provided by Google'), false);
      }

      const user: PassportUser = {
        email: emails[0].value,
        firstName: name?.givenName || '',
        lastName: name?.familyName || '',
        picture: photos?.[0]?.value,
        googleId: profile.id,
        accessToken,
      };
      done(null, user);
    } catch (error) {
      console.error('Google OAuth validation error:', error);
      done(error as Error, false);
    }
  }
}
