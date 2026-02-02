/**
 * Google OAuth Profile from Passport
 */
export interface GoogleProfile {
  id: string;
  name?: {
    givenName?: string;
    familyName?: string;
  };
  emails?: Array<{
    value: string;
    verified?: boolean;
  }>;
  photos?: Array<{
    value: string;
  }>;
  accessToken?: string;
  refreshToken?: string;
}

/**
 * Passport User object after validation
 */
export interface PassportUser {
  email: string;
  firstName: string;
  lastName: string;
  picture?: string;
  googleId: string;
  accessToken?: string;
}
