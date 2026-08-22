import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';

export interface ChatSessionClaims {
  /** Channel-native address — for the PWA, a device-scoped opaque id. */
  sid: string;
}

/**
 * Issues and verifies the device-scoped session that owns a conversation.
 *
 * This is the ONLY thing that grants access to a conversation's history. It is
 * deliberately not the phone number: the number a buyer types is unverified, so keying
 * history off it would let anyone read a stranger's orders by typing their number.
 *
 * The token proves continuity of a device and nothing more. It is not an identity and
 * confers no privileges anywhere else in the platform — note it is signed with the
 * chat secret and carries no `sub`, so it can never satisfy the platform's JWT guard.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly secret: string;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.secret = this.configService.get<string>('jwt.secret') ?? '';
  }

  /** Mint a session for a device we have not seen before. */
  async issue(): Promise<{ token: string; sessionId: string }> {
    const sessionId = randomUUID();
    const claims: ChatSessionClaims = { sid: sessionId };

    const token = await this.jwtService.signAsync(claims, {
      secret: this.secret,
      // Long-lived: losing it loses the chat history, and there is no login to
      // recover it with.
      expiresIn: '365d',
    });

    return { token, sessionId };
  }

  /**
   * Re-issue a token for a session that already exists.
   *
   * The server does not store tokens, only session ids, so this signs a fresh one for
   * the same session. Needed because the `session` event fires once on connect — a
   * client that was not listening yet would otherwise lose its device identity with no
   * way to ask for it back.
   */
  async tokenFor(sessionId: string): Promise<string> {
    const claims: ChatSessionClaims = { sid: sessionId };
    return this.jwtService.signAsync(claims, {
      secret: this.secret,
      expiresIn: '365d',
    });
  }

  /** Returns the session id, or null if the token is missing, forged or expired. */
  async verify(token?: string): Promise<string | null> {
    if (!token) return null;

    try {
      const claims = await this.jwtService.verifyAsync<ChatSessionClaims>(
        token,
        { secret: this.secret },
      );
      return claims.sid ?? null;
    } catch {
      this.logger.debug('Rejected an invalid chat session token');
      return null;
    }
  }
}
