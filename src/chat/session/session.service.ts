import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'crypto';

export interface ChatSessionClaims {
  /** Channel-native address — for the PWA, a device-scoped opaque id. */
  sid: string;
}

export interface VerifiedSession {
  sessionId: string;
  legacy: boolean;
}

/**
 * Issues and verifies the device-scoped session that owns a conversation.
 *
 * This is the ONLY thing that grants access to a conversation's history. It is
 * deliberately not the phone number: the number a buyer types is unverified, so keying
 * history off it would let anyone read a stranger's orders by typing their number.
 *
 * The token proves continuity of a device and nothing more. It is not an identity and
 * confers no privileges anywhere else in the platform.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly secret: string;
  /** The platform secret chat tokens used to be signed with. Verify-only, never signs. */
  private readonly legacySecret: string;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.legacySecret = this.configService.get<string>('jwt.secret') ?? '';
    this.secret =
      this.configService.get<string>('chat.sessionSecret') ||
      createHmac('sha256', this.legacySecret)
        .update('recommend:chat-session')
        .digest('hex');
  }

  /** Mint a session for a device we have not seen before. */
  async issue(): Promise<{ token: string; sessionId: string }> {
    const sessionId = randomUUID();
    const token = await this.tokenFor(sessionId);
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
    return (await this.inspect(token))?.sessionId ?? null;
  }

  /** As `verify`, and also says whether the token is due to be replaced. */
  async inspect(token?: string): Promise<VerifiedSession | null> {
    if (!token) return null;

    const current = await this.sidSignedWith(token, this.secret);
    if (current) return { sessionId: current, legacy: false };

    const legacy = this.legacySecret
      ? await this.sidSignedWith(token, this.legacySecret)
      : null;
    if (legacy) return { sessionId: legacy, legacy: true };

    this.logger.debug('Rejected an invalid chat session token');
    return null;
  }

  /**
   * The session id, if `token` is a chat token signed with `secret`. A platform access
   * token signed with the same secret is not one — it has no `sid` — and is refused.
   */
  private async sidSignedWith(
    token: string,
    secret: string,
  ): Promise<string | null> {
    try {
      const claims = await this.jwtService.verifyAsync<
        Partial<ChatSessionClaims>
      >(token, { secret });
      return typeof claims.sid === 'string' && claims.sid ? claims.sid : null;
    } catch {
      return null;
    }
  }
}
