import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { Inject, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import type { Server, Socket } from 'socket.io';
import { allowedOrigins } from '../../../config/cors';
import { Role } from '../../../common/enums/roles.enum';
import {
  CHAT_MESSAGE_RECORDED_EVENT,
  CONVERSATION_HOLDER_CHANGED_EVENT,
  ChatMessageRecordedEvent,
  ConversationHolderChangedEvent,
} from './admin-chat.events';
import {
  ADMIN_ALERT_EVENT,
  AdminAlertEvent,
  STAFF_ALERT_KINDS,
} from '../../../common/events/admin-alert.events';
import { IDENTITY_PORT } from '../../ports/identity.port';
import type { IdentityPort } from '../../ports/identity.port';

interface AdminSocketData {
  adminId?: string;
  /** Settles once the account behind the token has been checked: true if let in. */
  admitted?: Promise<boolean>;
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
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
  ) {}

  /**
   * A socket with no valid staff token is closed rather than ignored.
   *
   * Silently accepting it would leave an admin staring at a screen that never updates,
   * with nothing anywhere saying why. The role is read from the account, not the token:
   * a token lasts days, and someone demoted to customer service or suspended since must
   * not keep hearing what they no longer may.
   */
  async handleConnection(socket: Socket): Promise<void> {
    // Kept, so a watch sent the moment the socket opens waits for the account check
    // instead of arriving before it and being dropped.
    const admitted = this.admit(socket);
    (socket.data as AdminSocketData).admitted = admitted;
    await admitted;
  }

  private async admit(socket: Socket): Promise<boolean> {
    const token =
      (socket.handshake.auth?.token as string | undefined) ??
      socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');

    if (!token) {
      socket.emit('admin:error', { message: 'A token is required' });
      socket.disconnect(true);
      return false;
    }

    let subject: string;
    try {
      const payload = this.jwt.verify<{ sub: string; role?: Role }>(token, {
        secret: this.config.get<string>('jwt.secret'),
      });
      subject = payload.sub;
    } catch {
      socket.emit('admin:error', { message: 'That token is not valid' });
      socket.disconnect(true);
      return false;
    }

    const staff = await this.identity.staffMember(subject).catch(() => null);
    if (!staff) {
      socket.emit('admin:error', { message: 'Staff only' });
      socket.disconnect(true);
      return false;
    }

    (socket.data as AdminSocketData).adminId = staff.id;

    // Alerts: one room for all staff (the chat queue), one for admins (orders, payouts,
    // deliveries), and one per person for what is theirs alone.
    void socket.join(ALL_STAFF);
    if (staff.role !== Role.SUPPORT) void socket.join(ALL_ADMINS);
    void socket.join(adminRoom(staff.id));
    return true;
  }

  /**
   * Watch one conversation.
   *
   * Per-conversation rooms rather than one firehose: an admin reading a transcript should
   * not receive every message on the platform, and the room name is the conversation id
   * so leaving is symmetrical.
   */
  @SubscribeMessage('admin:watch')
  async watch(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { conversationId?: string },
  ): Promise<void> {
    const admitted = await (socket.data as AdminSocketData).admitted;
    const adminId = (socket.data as AdminSocketData).adminId;
    if (!admitted || !adminId || !data?.conversationId) return;

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
  async onMessageRecorded(event: ChatMessageRecordedEvent): Promise<void> {
    const { message } = event;
    // Which colleague typed it, so a second agent watching sees a name, not "you".
    const names = message.adminId
      ? await this.identity
          .staffNames([message.adminId])
          .catch(() => new Map<string, string>())
      : new Map<string, string>();

    this.server?.to(room(message.conversationId)).emit('admin:message', {
      id: message.id,
      conversationId: message.conversationId,
      direction: message.direction,
      author: message.author,
      adminId: message.adminId,
      adminName: message.adminId ? (names.get(message.adminId) ?? null) : null,
      text: message.text,
      payload: message.payload,
      createdAt: message.createdAt,
    });
  }

  @OnEvent(ADMIN_ALERT_EVENT)
  onAdminAlert(alert: AdminAlertEvent): void {
    const target = alert.adminId
      ? adminRoom(alert.adminId)
      : STAFF_ALERT_KINDS.includes(alert.kind)
        ? ALL_STAFF
        : ALL_ADMINS;

    this.server?.to(target).emit('admin:alert', {
      id: alert.id,
      kind: alert.kind,
      title: alert.title,
      body: alert.body,
      url: alert.url,
      createdAt: alert.createdAt,
    });
  }

  /**
   * Who has a chat now, to every agent's list — so nobody opens one a colleague has just
   * taken, and a chat handed back shows as free straight away.
   */
  @OnEvent(CONVERSATION_HOLDER_CHANGED_EVENT)
  async onHolderChanged(event: ConversationHolderChangedEvent): Promise<void> {
    const names = event.heldByAdminId
      ? await this.identity
          .staffNames([event.heldByAdminId])
          .catch(() => new Map<string, string>())
      : new Map<string, string>();

    this.server?.to(ALL_STAFF).emit('admin:conversation', {
      conversationId: event.conversationId,
      heldByAdminId: event.heldByAdminId,
      heldByName: event.heldByAdminId
        ? (names.get(event.heldByAdminId) ?? null)
        : null,
    });
  }
}

/** Everyone working the panel: admins and customer service. */
const ALL_STAFF = 'staff';
/** Admins only — alerts about orders, payouts and deliveries. */
const ALL_ADMINS = 'admins';

function adminRoom(adminId: string): string {
  return `admin:${adminId}`;
}

function room(conversationId: string): string {
  return `conversation:${conversationId}`;
}
