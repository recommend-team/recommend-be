import { Injectable, Logger } from '@nestjs/common';
import { ChatChannel } from '../enums/chat.enums';
import { ChannelAdapter, OutboundMessage } from './channel.interface';

/**
 * Where the engine finds a channel without knowing what channels exist.
 *
 * Adding WhatsApp is registering one more adapter here. No engine code changes.
 */
@Injectable()
export class ChannelRegistry {
  private readonly logger = new Logger(ChannelRegistry.name);
  private readonly adapters = new Map<ChatChannel, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
    this.logger.log(`Registered channel adapter: ${adapter.channel}`);
  }

  get(channel: ChatChannel): ChannelAdapter | undefined {
    return this.adapters.get(channel);
  }

  /**
   * Best-effort delivery. A missing adapter or an unreachable client is not an error —
   * the message is already persisted, and the client will see it in history.
   */
  async send(
    channel: ChatChannel,
    channelAddress: string,
    message: OutboundMessage,
  ): Promise<string | null> {
    const adapter = this.adapters.get(channel);

    if (!adapter) {
      this.logger.warn(`No adapter registered for channel ${channel}`);
      return null;
    }

    return adapter.send(channelAddress, message);
  }
}
