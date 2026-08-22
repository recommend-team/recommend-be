import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import type { Server, Socket } from 'socket.io';
import { allowedOrigins } from '../../../config/cors';
import { Role } from '../../../common/enums/roles.enum';
import {
  CHAT_MESSAGE_RECORDED_EVENT,
  ChatMessageRecordedEvent,
} from './admin-chat.events';

interface AdminSocketData {
  adminId: string;
}

/**
 * What an admin watches a conversation through.
 *
 * A namespace of its own rather than a role check bolted onto `/chat`. The two have
 * different doors: a buyer presents a device session token that grants access to exactly
 * one conversation, an admin presents a JWT that grants access to all of them.
 */
@WebSocketGateway({
  namespace: '/admin-chat',
  cors: { origin: allowedOrigins(), credentials: true },
})
export class AdminChatGateway implements OnGatewayConnection {
  private readonly logger = new Logger(AdminChatGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * A socket with no valid admin token is closed rather than ignored.
   *
   * Silently accepting it would leave an admin staring at a screen that never updates,
   * with nothing anywhere saying why.
   */
  handleConnection(socket: Socket): void {
    const token =
      (socket.handshake.auth?.token as string | undefined) ??
      socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');

    if (!token) {
      socket.emit('admin:error', { message: 'A token is required' });
      socket.disconnect(true);
      return;
    }

    try {
      const payload = this.jwt.verify<{ sub: string; role?: Role }>(token, {
        secret: this.config.get<string>('jwt.secret'),
      });

      if (payload.role !== Role.ADMIN && payload.role !== Role.SUPER_ADMIN) {
        socket.emit('admin:error', { message: 'Admins only' });
        socket.disconnect(true);
        return;
      }

      (socket.data as AdminSocketData).adminId = payload.sub;
    } catch {
      socket.emit('admin:error', { message: 'That token is not valid' });
      socket.disconnect(true);
    }
  }

  /**
   * Watch one conversation.
   *
   * Per-conversation rooms rather than one firehose: an admin reading a transcript should
   * not receive every message on the platform, and the room name is the conversation id
   * so leaving is symmetrical.
   */
  @SubscribeMessage('admin:watch')
  watch(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { conversationId?: string },
  ): void {
    const adminId = (socket.data as AdminSocketData).adminId;
    if (!adminId || !data?.conversationId) return;

    void socket.join(room(data.conversationId));
    this.logger.debug(
      `Admin ${adminId} is watching conversation ${data.conversationId}`,
    );
  }

  @SubscribeMessage('admin:unwatch')
  unwatch(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { conversationId?: string },
  ): void {
    if (!data?.conversationId) return;
    void socket.leave(room(data.conversationId));
  }

  /**
   * Relay every message to whoever is watching that conversation.
   *
   * Both directions. An admin needs to see the buyer typing back, and also their own
   * replies — which travel this way rather than being echoed by the REST call, so a
   * second admin's window stays correct too.
   */
  @OnEvent(CHAT_MESSAGE_RECORDED_EVENT)
  onMessageRecorded(event: ChatMessageRecordedEvent): void {
    const { message } = event;

    this.server?.to(room(message.conversationId)).emit('admin:message', {
      id: message.id,
      conversationId: message.conversationId,
      direction: message.direction,
      author: message.author,
      adminId: message.adminId,
      text: message.text,
      payload: message.payload,
      createdAt: message.createdAt,
    });
  }
}

function room(conversationId: string): string {
  return `conversation:${conversationId}`;
}
