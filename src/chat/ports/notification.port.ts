/**
 * Notification seam — the contract only. The adapter lands in B5 alongside the
 * `notifications` table, Brevo email and Web Push subscriptions.
 */

export const NOTIFICATION_PORT = Symbol('NOTIFICATION_PORT');

export interface VendorNotification {
  vendorId: string;
  type: 'NEW_ORDER' | 'ORDER_PAID' | 'ORDER_CANCELLED';
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface NotificationPort {
  notifyVendor(notification: VendorNotification): Promise<void>;
}
