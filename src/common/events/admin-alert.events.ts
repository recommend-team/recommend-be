/**
 * What admins are told about, and how it reaches them.
 *
 * The chat context reports what happened in a conversation; `AdminAlertsService`
 * (notifications) turns that, and the platform's own events, into alerts; the admin socket
 * broadcasts them. Events rather than calls, so neither side imports the other — the chat
 * context stays liftable into its own service (`src/chat/README.md`).
 */

/** The assistant flagged a conversation it is not coping with. Once per flag. */
export const CONVERSATION_NEEDS_ATTENTION_EVENT =
  'conversation.needs-attention';

export class ConversationNeedsAttentionEvent {
  constructor(
    readonly conversationId: string,
    readonly reason: string,
    /** What the buyer gave at checkout, if they got that far. Unverified. */
    readonly buyerName: string | null,
  ) {}
}

/**
 * A buyer wrote into a conversation an admin is holding. The assistant stays silent, so
 * this is the only way the admin learns there is something to answer.
 */
export const HELD_CONVERSATION_MESSAGE_EVENT = 'conversation.held-message';

export class HeldConversationMessageEvent {
  constructor(
    readonly conversationId: string,
    readonly adminId: string,
    readonly text: string,
    readonly buyerName: string | null,
  ) {}
}

export type AdminAlertKind =
  | 'CONVERSATION_FLAGGED'
  | 'HELD_CONVERSATION_MESSAGE'
  | 'NEW_PAID_ORDER'
  | 'WITHDRAWAL_FAILED';

/**
 * One alert, ready to send. Carries its own id so a panel that hears it twice — over the
 * socket and through the service worker — shows it once.
 */
export const ADMIN_ALERT_EVENT = 'admin.alert';

export class AdminAlertEvent {
  constructor(
    readonly id: string,
    readonly kind: AdminAlertKind,
    readonly title: string,
    readonly body: string,
    /** An admin-panel path, e.g. `/admin/conversations/<id>`. */
    readonly url: string,
    /** One admin, or null for every admin. */
    readonly adminId: string | null,
    readonly createdAt: Date,
  ) {}
}
