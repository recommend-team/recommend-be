import { ChatChannel } from '../enums/chat.enums';
import { MessagePayload } from '../conversation/entities/message.entity';

/**
 * The seam that keeps the engine channel-agnostic.
 */

export interface OutboundMessage {
  /** Plain-language text. Always populated, even when `payload` carries rich UI. */
  text: string;
  payload?: MessagePayload;
  messageId?: string;
  createdAt?: Date;
}

export interface ChannelAdapter {
  readonly channel: ChatChannel;

  /**
   * Deliver a message to a conversation's channel-native address. Returns the
   * channel's own message id where it issues one, or null where it does not.
   */
  send(
    channelAddress: string,
    message: OutboundMessage,
  ): Promise<string | null>;

  /** Live connection (PWA) or always-addressable (WhatsApp). */
  isReachable(channelAddress: string): boolean;
}
