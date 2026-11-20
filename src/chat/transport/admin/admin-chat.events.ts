import { ChatMessage } from '../../conversation/entities/message.entity';

/**
 * Every message, as it is written.
 */
export const CHAT_MESSAGE_RECORDED_EVENT = 'chat.message.recorded';

export class ChatMessageRecordedEvent {
  constructor(readonly message: ChatMessage) {}
}

/**
 * Someone took a conversation, or it went back to the assistant — released, or left
 * idle. Every agent's list shows who has each chat, so they all hear it.
 */
export const CONVERSATION_HOLDER_CHANGED_EVENT = 'chat.conversation.holder';

export class ConversationHolderChangedEvent {
  constructor(
    readonly conversationId: string,
    /** Who has it now; null when it is back with the assistant. */
    readonly heldByAdminId: string | null,
  ) {}
}
