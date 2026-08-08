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

interface SocketData {
  sessionId: string;
  conversationId: string;
}

/**
 * Mirrors the CORS allowlist in `main.ts`. Socket.IO does its own CORS handling, so
 * the Express-level configuration does not cover it.
 */
function chatCorsOrigins(): string[] | boolean {
  const isProduction = process.env.NODE_ENV === 'production';
  const frontendUrl = process.env.FRONTEND_URL;

  if (isProduction) return frontendUrl ? [frontendUrl] : false;
  return ['http://localhost:3000', 'https://recommend-fe.netlify.app'];
}

@WebSocketGateway({
  namespace: '/chat',
  cors: { origin: chatCorsOrigins(), credentials: true },
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
      let sessionId = await this.sessionService.verify(presented);

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

      await socket.join(sessionId);

      const conversation = await this.conversationService.findOrCreate(
        ChatChannel.PWA,
        sessionId,
      );

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

    const messages = await this.conversationService.getHistory(
      data.conversationId,
      {
        before: body?.before ? new Date(body.before) : undefined,
        limit: body?.limit,
      },
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
}

function extractToken(socket: Socket): string | undefined {
  const fromAuth = socket.handshake.auth?.token as unknown;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;

  const fromQuery = socket.handshake.query?.token;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;

  return undefined;
}
