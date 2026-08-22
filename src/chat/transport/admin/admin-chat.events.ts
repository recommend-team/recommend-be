import { ChatMessage } from '../../conversation/entities/message.entity';

/**
 * Every message, as it is written.
 */
export const CHAT_MESSAGE_RECORDED_EVENT = 'chat.message.recorded';

export class ChatMessageRecordedEvent {
  constructor(readonly message: ChatMessage) {}
}
