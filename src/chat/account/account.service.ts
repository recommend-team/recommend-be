import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  IsNull,
  MoreThanOrEqual,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { z } from 'zod';
import { ChatAccount } from './entities/chat-account.entity';
import { Conversation } from '../conversation/entities/conversation.entity';
import { ChatMessage } from '../conversation/entities/message.entity';
import { BuyerPushSubscription } from '../conversation/entities/buyer-push-subscription.entity';
import { MessageDirection } from '../enums/chat.enums';
import { EMAIL_PORT, type EmailPort } from '../ports/email.port';
import {
  CODE_TTL_MINUTES,
  LoginCodeService,
  RESEND_COOLDOWN_SECONDS,
} from './login-code.service';
import { mergeConversations } from './merge';

const emailSchema = z.string().trim().toLowerCase().email().max(254);

export type RequestCodeResult =
  | { ok: true; email: string; resendAfter: number }
  | {
      ok: false;
      code: 'INVALID_EMAIL' | 'COOLDOWN' | 'TOO_MANY' | 'SEND_FAILED';
      retryAfter?: number;
    };

/** The conversation a browser is on after signing in, and whether that made the account. */
interface SignedIn {
  conversation: Conversation;
  created: boolean;
}

export type VerifyResult =
  | { ok: true; email: string; conversation: Conversation }
  | {
      ok: false;
      code:
        | 'INVALID_EMAIL'
        | 'WRONG_CODE'
        | 'CODE_EXPIRED'
        | 'TOO_MANY_ATTEMPTS';
      attemptsLeft?: number;
    };

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @InjectRepository(ChatAccount)
    private readonly accounts: Repository<ChatAccount>,
    private readonly codes: LoginCodeService,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Email a code. The answer is the same whether or not the address has an account —
   * this must not tell anyone which emails belong to buyers.
   */
  async requestCode(
    rawEmail: string,
    sessionId: string,
  ): Promise<RequestCodeResult> {
    const email = normalise(rawEmail);
    if (!email) return { ok: false, code: 'INVALID_EMAIL' };

    const issued = await this.codes.issue(email, sessionId);
    if (!issued.ok) {
      return { ok: false, code: issued.reason, retryAfter: issued.retryAfter };
    }

    try {
      await this.email.sendSignInCode(email, issued.code, CODE_TTL_MINUTES);
    } catch (error) {
      this.logger.error(
        `Could not send a sign-in code: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return { ok: false, code: 'SEND_FAILED' };
    }

    return { ok: true, email, resendAfter: RESEND_COOLDOWN_SECONDS };
  }

  /** Check the code and, if it is right, sign this conversation in. */
  async verify(
    rawEmail: string,
    code: string,
    conversationId: string,
  ): Promise<VerifyResult> {
    const email = normalise(rawEmail);
    if (!email) return { ok: false, code: 'INVALID_EMAIL' };

    const checked = await this.codes.check(email, (code ?? '').toString());
    if (!checked.ok) {
      if (checked.reason === 'WRONG') {
        return {
          ok: false,
          code: 'WRONG_CODE',
          attemptsLeft: checked.attemptsLeft,
        };
      }
      return {
        ok: false,
        code:
          checked.reason === 'LOCKED' ? 'TOO_MANY_ATTEMPTS' : 'CODE_EXPIRED',
      };
    }

    const { conversation, created } = await this.signIn(email, conversationId);

    if (created) {
      void this.email.sendWelcome(email, conversation.context?.profile?.name);
    }

    return { ok: true, email, conversation };
  }

  /** The verified email this conversation belongs to, if any. */
  async emailFor(
    conversation: Pick<Conversation, 'accountId'>,
  ): Promise<string | null> {
    if (!conversation.accountId) return null;
    const account = await this.accounts.findOne({
      where: { id: conversation.accountId },
    });
    return account?.email ?? null;
  }

  /**
   * Attach `conversationId` to the account for `email`, or fold it into the account's
   * conversation. Returns the conversation this browser should now be on.
   *
   * Two browsers verifying the same new email at the same moment would both try to claim
   * it; the unique index lets one win, and the other retries and folds into it.
   */
  private async signIn(
    email: string,
    conversationId: string,
  ): Promise<SignedIn> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.dataSource.transaction((manager) =>
          this.signInWithin(manager, email, conversationId),
        );
      } catch (error) {
        if (attempt === 0 && isUniqueViolation(error)) continue;
        throw error;
      }
    }
  }

  private async signInWithin(
    manager: EntityManager,
    email: string,
    conversationId: string,
  ): Promise<SignedIn> {
    // Whether this insert made the account — not a read beforehand, which two browsers
    // verifying at once would both pass. An ignored insert returns no row.
    const inserted = await manager
      .createQueryBuilder()
      .insert()
      .into(ChatAccount)
      .values({ email })
      .orIgnore()
      .execute();
    const created =
      Array.isArray(inserted?.raw) && (inserted.raw as unknown[]).length > 0;
    const account = await manager.findOneOrFail(ChatAccount, {
      where: { email },
    });
    await manager.update(
      ChatAccount,
      { id: account.id },
      { lastSignedInAt: new Date() },
    );

    const current = await manager.findOneOrFail(Conversation, {
      where: { id: conversationId },
      lock: { mode: 'pessimistic_write' },
    });
    const home = await manager.findOne(Conversation, {
      where: { accountId: account.id, mergedIntoId: IsNull() },
      lock: { mode: 'pessimistic_write' },
    });

    // The first browser to sign in: its conversation becomes the account's.
    if (!home || home.id === current.id) {
      current.accountId = account.id;
      current.context = {
        ...current.context,
        profile: { ...current.context?.profile, email },
      };
      await manager.update(
        Conversation,
        { id: current.id },
        { accountId: account.id, context: current.context },
      );
      this.logger.log(`Conversation ${current.id} signed in`);
      return { conversation: current, created };
    }

    // Another browser: fold this conversation into the account's.
    const firstBuyerMessage = await manager.findOne(ChatMessage, {
      where: {
        conversationId: current.id,
        direction: MessageDirection.INBOUND,
      },
      order: { createdAt: 'ASC' },
    });
    const merged = mergeConversations(
      home,
      current,
      !!firstBuyerMessage,
      email,
    );
    if (firstBuyerMessage) {
      await manager.update(
        ChatMessage,
        {
          conversationId: current.id,
          createdAt: MoreThanOrEqual(firstBuyerMessage.createdAt),
        },
        { conversationId: home.id },
      );
    }
    await manager.update(
      BuyerPushSubscription,
      { conversationId: current.id },
      { conversationId: home.id },
    );
    await manager.update(Conversation, { id: home.id }, merged);
    await manager.update(
      Conversation,
      { id: current.id },
      {
        mergedIntoId: home.id,
        heldByAdminId: null,
        heldAt: null,
        needsAttentionAt: null,
        attentionReason: null,
        handoverRequestedAt: null,
        handoverReason: null,
        context: {
          ...current.context,
          pendingPaymentReference: undefined,
          pendingCheckoutId: undefined,
        },
      },
    );

    this.logger.log(
      `Conversation ${current.id} folded into ${home.id} on sign-in`,
    );
    return { conversation: Object.assign(home, merged), created };
  }
}

function normalise(raw: string): string | null {
  const parsed = emailSchema.safeParse(raw ?? '');
  return parsed.success ? parsed.data : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string } | undefined)?.code === '23505'
  );
}
