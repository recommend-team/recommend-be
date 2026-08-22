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

  /**
   * Signal that a reply is being composed. Optional because not every channel has one —
   * but WhatsApp does, so it belongs on the seam rather than in PWA-specific code.
   *
   * It matters most when a person is answering: a buyer who believes they are talking to
   * software will wait through "typing…" and will not wait through silence.
   */
  emitTyping?(channelAddress: string, isTyping: boolean): void;
}
