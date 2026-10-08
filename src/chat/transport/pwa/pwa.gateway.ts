import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import { SessionService } from '../../session/session.service';
import { ConversationService } from '../../conversation/conversation.service';
import { EngineService } from '../../engine/engine.service';
import { ChannelRegistry } from '../channel.registry';
import { PwaChannel } from './pwa.channel';
import { ChatChannel } from '../../enums/chat.enums';
import { ChatRateLimitService } from '../../session/rate-limit.service';
import { allowedOrigins } from '../../../config/cors';
import { BuyerPushService } from '../../engine/buyer-push.service';
import { AccountService } from '../../account/account.service';
import type { Conversation } from '../../conversation/entities/conversation.entity';

/** Buyer-facing wording for each sign-in failure. The sheet shows it as it is. */
const ACCOUNT_ERRORS: Record<string, string> = {
  INVALID_EMAIL: 'That email address does not look right.',
  COOLDOWN: 'We just sent a code. Give it a moment before asking for another.',
  TOO_MANY: 'Too many codes requested. Please try again in an hour.',
  SEND_FAILED: 'We could not send the email just now. Please try again.',
  WRONG_CODE: 'That code is not right. Check the email and try again.',
  CODE_EXPIRED: 'That code has expired. Ask for a new one.',
  TOO_MANY_ATTEMPTS: 'Too many wrong tries. Ask for a new code.',
};

interface SocketData {
  sessionId: string;
  conversationId: string;
}

@WebSocketGateway({
  namespace: '/chat',
  // Same allowlist as the REST API. Socket.IO does its own CORS and ignores
  // `enableCors`, so allowing an origin there but not here would leave the API working
  // and the chat silently refusing to connect.
  cors: { origin: allowedOrigins(), credentials: true },
})
export class PwaGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(PwaGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly sessionService: SessionService,
    private readonly conversationService: ConversationService,
    private readonly engineService: EngineService,
    private readonly channelRegistry: ChannelRegistry,
    private readonly pwaChannel: PwaChannel,
    private readonly rateLimitService: ChatRateLimitService,
    private readonly buyerPush: BuyerPushService,
    private readonly accountService: AccountService,
  ) {}

  afterInit(server: Server): void {
    this.pwaChannel.attach(server);
    this.channelRegistry.register(this.pwaChannel);
    this.logger.log('Chat gateway ready on /chat');
  }

  /**
   * Socket.IO starts delivering events as soon as the socket connects — it does not
   * wait for handleConnection to finish. A client that emits immediately would find
   * socket.data empty and get silence. Handlers await this instead.
   */
  private readonly setup = new WeakMap<Socket, Promise<void>>();

  /**
   * A device presents its token, or gets a new one. The token — not any phone number —
   * is what grants access to a conversation's history.
   */
  handleConnection(socket: Socket): Promise<void> {
    const ready = this.initialise(socket);
    this.setup.set(socket, ready);
    return ready;
  }

  /** Resolves once connection setup has finished, or null if it failed. */
  private async awaitReady(socket: Socket): Promise<SocketData | null> {
    await this.setup.get(socket);
    const data = socket.data as SocketData;
    return data?.conversationId ? data : null;
  }

  private async initialise(socket: Socket): Promise<void> {
    try {
      const presented = extractToken(socket);
      const verified = await this.sessionService.inspect(presented);
      let sessionId = verified?.sessionId ?? null;

      // Signed under the old scheme. Same session, same thread — just a token that is
      // no longer signed with the platform's login secret.
      if (verified?.legacy) {
        socket.emit('session', {
          token: await this.sessionService.tokenFor(verified.sessionId),
          sessionId: verified.sessionId,
        });
      }

      // Unknown, forged or expired token: issue a fresh session rather than refusing
      // the connection. A buyer with a stale token gets a working chat, not an error.
      if (!sessionId) {
        const issued = await this.sessionService.issue();
        sessionId = issued.sessionId;
        socket.emit('session', {
          token: issued.token,
          sessionId: issued.sessionId,
        });
      }

      let conversation = await this.conversationService.findOrCreate(
        ChatChannel.PWA,
        sessionId,
      );

      // This browser's thread was folded into a signed-in buyer's, and it missed the
      // new token (closed mid-sign-in, or another tab). Move it across now.
      if (conversation.mergedIntoId) {
        conversation = await this.conversationService.resolveLive(conversation);
        sessionId = conversation.channelAddress;
        socket.emit('session', {
          token: await this.sessionService.tokenFor(sessionId),
          sessionId,
        });
      }

      await socket.join(sessionId);

      (socket.data as SocketData) = {
        sessionId,
        conversationId: conversation.id,
      };

      const messageCount = await this.conversationService.countMessages(
        conversation.id,
      );
      if (messageCount === 0) {
        await this.engineService.greet(conversation);
      }
    } catch (error) {
      this.logger.error(
        `Connection setup failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      socket.emit('chat:error', {
        code: 'CONNECTION_FAILED',
        message: 'Could not start the chat. Please try again.',
      });
      socket.disconnect(true);
    }
  }

  /**
   * Ask for the current session token.
   *
   * `session` is emitted once during connection setup, which a client that attaches
   * its listeners after connecting will miss — and without the token the device loses
   * its thread permanently. This makes it retrievable on demand instead.
   */
  @SubscribeMessage('session:get')
  async onSessionGet(@ConnectedSocket() socket: Socket): Promise<void> {
    const data = await this.awaitReady(socket);

    if (!data?.sessionId) {
      socket.emit('chat:error', {
        code: 'NO_SESSION',
        message: 'Session not ready. Reconnect and try again.',
      });
      return;
    }

    const token = await this.sessionService.tokenFor(data.sessionId);
    socket.emit('session', { token, sessionId: data.sessionId });
  }

  @SubscribeMessage('chat:message')
  async onMessage(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    body: {
      text?: string;
      clientMessageId?: string;
      cart?: { itemCount: number; vendorCount: number };
    },
  ): Promise<void> {
    const data = await this.awaitReady(socket);
    const text = (body?.text ?? '').toString().slice(0, 2000);

    if (!data?.conversationId) {
      socket.emit('chat:error', {
        code: 'NO_SESSION',
        message: 'Session not ready. Reconnect and try again.',
      });
      return;
    }

    const conversation = await this.conversationService.findById(
      data.conversationId,
    );
    if (!conversation) {
      socket.emit('chat:error', {
        code: 'NO_CONVERSATION',
        message: 'Conversation not found.',
      });
      return;
    }

    // Checked before any model work, so a throttled message costs nothing.
    const verdict = await this.rateLimitService.consume(data.sessionId);
    if (!verdict.allowed) {
      socket.emit('chat:error', {
        code: 'RATE_LIMITED',
        message:
          "You're sending messages very quickly. Give it a moment and try again.",
        retryAfter: verdict.retryAfter,
      });
      return;
    }

    this.pwaChannel.emitTyping(data.sessionId, true);
    try {
      await this.engineService.handleInbound({
        conversation,
        text,
        clientMessageId: body?.clientMessageId,
        cart: body?.cart,
      });
    } catch (error) {
      // Anything unhandled downstream would otherwise leave the buyer staring at a
      // dead chat with no indication that their message went nowhere. Say something.
      this.logger.error(
        `Failed to handle message on conversation ${data.conversationId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      socket.emit('chat:error', {
        code: 'REPLY_FAILED',
        message: 'Something went wrong on our side. Please try that again.',
      });
    } finally {
      this.pwaChannel.emitTyping(data.sessionId, false);
    }
  }

  /**
   * The buyer tapped Pay. The cart lives in their browser, so it is handed over here —
   * quantities are taken at face value, prices are recomputed from the database at
   * checkout and whatever the client claimed is ignored.
   */
  @SubscribeMessage('checkout:start')
  async onCheckoutStart(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    body: {
      items?: {
        productId?: string;
        quantity?: number;
        expectedUnitPrice?: number;
      }[];
      text?: string;
    },
  ): Promise<void> {
    const data = await this.awaitReady(socket);
    if (!data?.conversationId) {
      socket.emit('chat:error', {
        code: 'NO_SESSION',
        message: 'Session not ready. Reconnect and try again.',
      });
      return;
    }

    const verdict = await this.rateLimitService.consume(data.sessionId);
    if (!verdict.allowed) {
      socket.emit('chat:error', {
        code: 'RATE_LIMITED',
        message: "You're going a bit fast. Give it a moment and try again.",
        retryAfter: verdict.retryAfter,
      });
      return;
    }

    const cart = (body?.items ?? [])
      .filter(
        (item) =>
          typeof item?.productId === 'string' &&
          Number.isInteger(item?.quantity) &&
          (item.quantity ?? 0) > 0,
      )
      .slice(0, 50)
      .map((item) => ({
        productId: item.productId as string,
        quantity: Math.min(50, item.quantity as number),
        expectedUnitPrice:
          typeof item.expectedUnitPrice === 'number'
            ? item.expectedUnitPrice
            : undefined,
      }));

    const conversation = await this.conversationService.findById(
      data.conversationId,
    );
    if (!conversation) {
      socket.emit('chat:error', {
        code: 'NO_CONVERSATION',
        message: 'Conversation not found.',
      });
      return;
    }

    this.pwaChannel.emitTyping(data.sessionId, true);
    try {
      await this.engineService.startCheckout(
        conversation,
        cart,
        typeof body?.text === 'string' && body.text.trim()
          ? body.text.slice(0, 200)
          : undefined,
      );
    } catch (error) {
      this.logger.error(
        `Failed to start checkout on ${data.conversationId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      socket.emit('chat:error', {
        code: 'CHECKOUT_FAILED',
        message: 'Something went wrong starting your order. Please try again.',
      });
    } finally {
      this.pwaChannel.emitTyping(data.sessionId, false);
    }
  }

  @SubscribeMessage('chat:history')
  async onHistory(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { before?: string; limit?: number },
  ): Promise<void> {
    const data = await this.awaitReady(socket);
    if (!data?.conversationId) {
      // Never fail silently — a client waiting on chat:history would hang forever.
      socket.emit('chat:error', {
        code: 'NO_SESSION',
        message: 'Session not ready. Reconnect and try again.',
      });
      return;
    }

    await this.sendHistory(socket, data.conversationId, {
      before: body?.before ? new Date(body.before) : undefined,
      limit: body?.limit,
    });
  }

  private async sendHistory(
    socket: Socket,
    conversationId: string,
    options: { before?: Date; limit?: number } = {},
  ): Promise<void> {
    const messages = await this.conversationService.getHistory(
      conversationId,
      options,
    );

    socket.emit('chat:history', {
      messages: messages.map((message) => ({
        id: message.id,
        author: message.author,
        text: message.text,
        payload: message.payload,
        createdAt: message.createdAt,
      })),
    });
  }

  // ─── Signing in by email ──────────────────────────────────────────────────────
  //
  // Optional, and never needed to chat. A verified email lets the conversation follow
  // the buyer to any browser: see AccountService.

  /** Who this browser is signed in as. Answered with `account`. */
  @SubscribeMessage('account:get')
  async onAccountGet(@ConnectedSocket() socket: Socket): Promise<void> {
    const conversation = await this.liveConversation(socket);
    if (!conversation) return;
    socket.emit('account', {
      email: await this.accountService.emailFor(conversation),
    });
  }

  /** Email a sign-in code. Answered with `account:code-sent` or `account:error`. */
  @SubscribeMessage('account:request-code')
  async onRequestCode(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { email?: string },
  ): Promise<void> {
    const data = await this.awaitReady(socket);
    if (!data) return this.notReady(socket);

    const result = await this.accountService.requestCode(
      (body?.email ?? '').toString(),
      data.sessionId,
    );
    if (result.ok) {
      socket.emit('account:code-sent', {
        email: result.email,
        resendAfter: result.resendAfter,
      });
      return;
    }
    socket.emit('account:error', {
      code: result.code,
      message: ACCOUNT_ERRORS[result.code],
      retryAfter: result.retryAfter,
    });
  }

  /**
   * Check a code and sign this browser in. On success it may be moved onto the
   * account's conversation from another browser — a new `session` token, then
   * `account`, then the thread as it now stands in `chat:history`.
   */
  @SubscribeMessage('account:verify')
  async onVerify(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { email?: string; code?: string },
  ): Promise<void> {
    const data = await this.awaitReady(socket);
    if (!data) return this.notReady(socket);

    const result = await this.accountService.verify(
      (body?.email ?? '').toString(),
      (body?.code ?? '').toString(),
      data.conversationId,
    );
    if (!result.ok) {
      socket.emit('account:error', {
        code: result.code,
        message: ACCOUNT_ERRORS[result.code],
        attemptsLeft: result.attemptsLeft,
      });
      return;
    }

    await this.moveTo(socket, data, result.conversation);
    socket.emit('account', { email: result.email });
    await this.sendHistory(socket, result.conversation.id);
  }

  /**
   * Sign this browser out: it starts a fresh guest chat. The account, and its
   * conversation on every other browser, are untouched.
   */
  @SubscribeMessage('account:sign-out')
  async onSignOut(@ConnectedSocket() socket: Socket): Promise<void> {
    const data = await this.awaitReady(socket);
    if (!data) return this.notReady(socket);

    const issued = await this.sessionService.issue();
    const conversation = await this.conversationService.findOrCreate(
      ChatChannel.PWA,
      issued.sessionId,
    );
    await this.moveTo(socket, data, conversation);
    socket.emit('account', { email: null });
    await this.engineService.greet(conversation);
    await this.sendHistory(socket, conversation.id);
  }

  /** Point this socket at another conversation, and hand the browser its token. */
  private async moveTo(
    socket: Socket,
    from: SocketData,
    conversation: Conversation,
  ): Promise<void> {
    const sessionId = conversation.channelAddress;
    if (sessionId !== from.sessionId) {
      await socket.leave(from.sessionId);
      await socket.join(sessionId);
    }
    (socket.data as SocketData) = {
      sessionId,
      conversationId: conversation.id,
    };
    socket.emit('session', {
      token: await this.sessionService.tokenFor(sessionId),
      sessionId,
    });
  }

  private async liveConversation(socket: Socket): Promise<Conversation | null> {
    const data = await this.awaitReady(socket);
    if (!data) {
      this.notReady(socket);
      return null;
    }
    return this.conversationService.findById(data.conversationId);
  }

  private notReady(socket: Socket): void {
    socket.emit('chat:error', {
      code: 'NO_SESSION',
      message: 'Session not ready. Reconnect and try again.',
    });
  }

  /**
   * The buyer's own orders.
   *
   * Over the socket rather than REST because the device session *is* the identity here,
   * and the socket already authenticates it. A public HTTP endpoint would have to be
   * keyed on the reference alone, which is a secret only in the sense that it is long.
   */
  @SubscribeMessage('orders:list')
  async onOrdersList(@ConnectedSocket() socket: Socket): Promise<void> {
    const data = await this.awaitReady(socket);
    if (!data?.conversationId) {
      socket.emit('chat:error', {
        code: 'NO_SESSION',
        message: 'Session not ready. Reconnect and try again.',
      });
      return;
    }

    const orders = await this.engineService.listOrders(data.conversationId);
    socket.emit('orders:list', { orders });
  }

  /**
   * "I have it."
   *
   * The conversation is checked against the reference before anything moves — a device
   * may only complete an order it actually placed. Without that, knowing a reference
   * would be enough to close someone else's delivery.
   */
  @SubscribeMessage('orders:complete')
  async onOrderComplete(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { reference?: string },
  ): Promise<void> {
    const data = await this.awaitReady(socket);
    if (!data?.conversationId) {
      socket.emit('chat:error', {
        code: 'NO_SESSION',
        message: 'Session not ready. Reconnect and try again.',
      });
      return;
    }

    const reference = body?.reference?.trim();
    if (!reference) return;

    try {
      const orders = await this.engineService.completeOrder(
        data.conversationId,
        reference,
      );
      socket.emit('orders:list', { orders });
    } catch (error) {
      this.logger.warn(
        `Could not complete ${reference} for conversation ${data.conversationId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      socket.emit('chat:error', {
        code: 'CHECKOUT_FAILED',
        message: "We couldn't confirm that just now. Please try again.",
      });
    }
  }

  /**
   * "Tell me when it's on its way." Registers this device for the few order updates
   * worth a notification. The conversation is the socket's own — a device can only ever
   * subscribe to its own thread. Answered with `push:subscribed`.
   */
  @SubscribeMessage('push:subscribe')
  async onPushSubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    body: { endpoint?: unknown; keys?: unknown; userAgent?: unknown },
  ): Promise<void> {
    const data = await this.awaitReady(socket);
    if (!data?.conversationId) {
      socket.emit('push:subscribed', { ok: false });
      return;
    }

    try {
      const ok = await this.buyerPush.subscribe(data.conversationId, {
        endpoint: body?.endpoint,
        keys: body?.keys,
        userAgent: body?.userAgent,
      });
      socket.emit('push:subscribed', { ok });
    } catch (error) {
      this.logger.warn(
        `Could not register a push device for ${data.conversationId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      socket.emit('push:subscribed', { ok: false });
    }
  }

  @SubscribeMessage('push:unsubscribe')
  async onPushUnsubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { endpoint?: unknown },
  ): Promise<void> {
    const data = await this.awaitReady(socket);
    if (!data?.conversationId) return;
    await this.buyerPush
      .unsubscribe(data.conversationId, body?.endpoint)
      .catch(() => undefined);
  }
}

function extractToken(socket: Socket): string | undefined {
  const fromAuth = socket.handshake.auth?.token as unknown;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;

  const fromQuery = socket.handshake.query?.token;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;

  return undefined;
}
