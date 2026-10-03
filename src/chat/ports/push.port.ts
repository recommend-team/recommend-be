/**
 * Web push, as the chat context needs it: send to devices it already holds.
 *
 * The chat owns its buyers' subscriptions (they are keyed to a conversation, not a user);
 * the platform owns the VAPID keys and the sending. When the chat becomes a service, this
 * is an HTTP call and nothing in the engine changes.
 */

export const PUSH_PORT = Symbol('PUSH_PORT');

export interface PushDevice {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface BuyerPushMessage {
  title: string;
  body: string;
  /** What happened, so the device can decide how to present it. */
  type: 'PAYMENT_CONFIRMED' | 'ORDER_READY' | 'ORDER_DISPATCHED' | 'REPLY';
  /** Always the chat — the conversation is where everything about the order lives. */
  url: string;
  /** A later push with the same tag replaces this one on the device. */
  tag: string;
}

export interface PushPort {
  /** False when push is switched off (no VAPID keys) — callers skip the work entirely. */
  isEnabled(): boolean;
  /**
   * Never throws. Returns the endpoints that no longer exist, for the caller to forget.
   */
  deliver(
    devices: PushDevice[],
    message: BuyerPushMessage,
    delivery?: { urgency?: 'normal' | 'high'; ttlSeconds?: number },
  ): Promise<{ gone: string[] }>;
}
