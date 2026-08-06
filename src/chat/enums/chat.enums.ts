/** Transport a conversation is happening over. Adding one must not touch engine code. */
export enum ChatChannel {
  PWA = 'PWA',
  WHATSAPP = 'WHATSAPP',
}

/**
 * Where a conversation sits in the funnel.
 *
 * DISCOVERY is the only free-form state — the LLM will drive it from B3. Everything
 * from SELECTING_ITEM onwards is deterministic, because it leads to a charge.
 */
export enum ConversationState {
  DISCOVERY = 'DISCOVERY',
  SELECTING_ITEM = 'SELECTING_ITEM',
  COLLECTING_NAME = 'COLLECTING_NAME',
  COLLECTING_PHONE = 'COLLECTING_PHONE',
  COLLECTING_FULFILLMENT = 'COLLECTING_FULFILLMENT',
  COLLECTING_ADDRESS = 'COLLECTING_ADDRESS',
  CONFIRMING_ORDER = 'CONFIRMING_ORDER',
  AWAITING_PAYMENT = 'AWAITING_PAYMENT',
}

export enum MessageDirection {
  INBOUND = 'INBOUND',
  OUTBOUND = 'OUTBOUND',
}

export enum MessageAuthor {
  BUYER = 'BUYER',
  ASSISTANT = 'ASSISTANT',
  SYSTEM = 'SYSTEM',
}
