import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import { ChatChannel } from '../../enums/chat.enums';
import { ChannelAdapter, OutboundMessage } from '../channel.interface';

/**
 * Socket.IO implementation of `ChannelAdapter`.
 *
 * Every device joins a room named after its session id, so delivery is a room emit and
 * a buyer with the app open in two tabs sees the reply in both.
 */
@Injectable()
export class PwaChannel implements ChannelAdapter {
  readonly channel = ChatChannel.PWA;

  private readonly logger = new Logger(PwaChannel.name);
  private server: Server | null = null;

  /** Called by the gateway once Socket.IO has started. */
  attach(server: Server): void {
    this.server = server;
  }

  send(
    channelAddress: string,
    message: OutboundMessage,
  ): Promise<string | null> {
    if (!this.server) {
      this.logger.warn(
        'Socket.IO server not attached yet — message not emitted',
      );
      return Promise.resolve(null);
    }

    this.server.to(channelAddress).emit('chat:message', {
      id: message.messageId,
      author: 'ASSISTANT',
      text: message.text,
      payload: message.payload ?? null,
      createdAt: message.createdAt ?? new Date(),
    });

    // Socket.IO issues no durable message id of its own — the database id is the id.
    return Promise.resolve(null);
  }

  isReachable(channelAddress: string): boolean {
    const room = this.server?.sockets.adapter.rooms.get(channelAddress);
    return (room?.size ?? 0) > 0;
  }

  /** Fire-and-forget signal that the assistant is working on a reply. */
  emitTyping(channelAddress: string, isTyping: boolean): void {
    this.server?.to(channelAddress).emit('chat:typing', { isTyping });
  }
}
