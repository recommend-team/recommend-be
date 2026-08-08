import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { Notification, NotificationType } from './entities/notification.entity';
import { PushService } from './push.service';
import { EmailService } from '../../common/services/email.service';
import { User } from '../auth/entities/auth.entity';
import {
  CHECKOUT_PAID_EVENT,
  CheckoutPaidEvent,
  CheckoutPaidVendorOrder,
} from '../../common/events/checkout-paid.event';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly pushService: PushService,
    private readonly emailService: EmailService,
  ) {}

  /**
   * A paid checkout is the moment vendors need to know something. Each vendor is
   * told about their own part only — never the whole basket, which may include
   * another restaurant's items.
   */
  @OnEvent(CHECKOUT_PAID_EVENT)
  async onCheckoutPaid(event: CheckoutPaidEvent): Promise<void> {
    for (const order of event.orders) {
      try {
        await this.notifyVendorOfOrder(event, order);
      } catch (error) {
        // One vendor's notification failing must not stop the others, and must
        // never bubble back into the webhook that triggered it.
        this.logger.error(
          `Failed to notify vendor ${order.vendorId} about order ${order.orderId}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }

  private async notifyVendorOfOrder(
    event: CheckoutPaidEvent,
    order: CheckoutPaidVendorOrder,
  ): Promise<void> {
    const summary = order.items
      .map((item) => `${item.quantity}× ${item.name}`)
      .join(', ');

    const title = 'New paid order';
    const body =
      `${event.buyerName} paid for ${summary}. ` +
      `${event.fulfillmentType === 'DELIVERY' ? 'Delivery' : 'Pickup'} — ` +
      `you earn ₦${order.vendorAmount.toLocaleString()}.`;

    // The feed is written first and is the durable record. Email and push are
    // best-effort layers on top of it.
    const notification = await this.create({
      userId: order.vendorId,
      type: NotificationType.NEW_ORDER,
      title,
      body,
      data: {
        orderId: order.orderId,
        checkoutId: event.checkoutId,
        reference: event.reference,
        buyerName: event.buyerName,
        buyerPhone: event.buyerPhone,
        fulfillmentType: event.fulfillmentType,
        deliveryAddress: event.deliveryAddress,
        subtotal: order.subtotal,
        vendorAmount: order.vendorAmount,
        items: order.items,
      },
    });

    await Promise.all([
      this.pushService
        .sendToUser(order.vendorId, {
          title,
          body,
          data: { notificationId: notification.id, orderId: order.orderId },
        })
        .catch((error: unknown) => {
          this.logger.warn(`Push failed for vendor ${order.vendorId}`, error);
          return 0;
        }),
      this.emailVendor(order.vendorId, title, body, event, order),
    ]);
  }

  private async emailVendor(
    vendorId: string,
    title: string,
    body: string,
    event: CheckoutPaidEvent,
    order: CheckoutPaidVendorOrder,
  ): Promise<void> {
    const vendor = await this.users.findOne({
      where: { id: vendorId },
      select: ['id', 'email', 'businessName'],
    });

    if (!vendor?.email || vendor.email.endsWith('@buyers.recommend.ng')) return;

    const lines = order.items
      .map((item) => `  • ${item.quantity} × ${item.name}`)
      .join('\n');

    try {
      await this.emailService.sendEmail({
        to: vendor.email,
        subject: `${title} — ${event.reference}`,
        text:
          `${body}\n\n` +
          `Order reference: ${event.reference}\n` +
          `Buyer: ${event.buyerName} (${event.buyerPhone})\n` +
          `Fulfillment: ${event.fulfillmentType}\n` +
          (event.deliveryAddress ? `Address: ${event.deliveryAddress}\n` : '') +
          `\nItems:\n${lines}\n\n` +
          `Your payout: ₦${order.vendorAmount.toLocaleString()}\n`,
      });
    } catch (error) {
      // Brevo not configured, or down. The feed entry already exists.
      this.logger.warn(
        `Email to vendor ${vendorId} failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  // ─── Feed ───────────────────────────────────────────────────────────────────

  async create(input: {
    userId: string;
    type: NotificationType;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }): Promise<Notification> {
    const notification = this.notifications.create({
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      data: input.data ?? null,
      readAt: null,
    });
    return this.notifications.save(notification);
  }

  async list(
    userId: string,
    query: { unreadOnly?: boolean; page?: number; limit?: number } = {},
  ): Promise<{
    items: Notification[];
    total: number;
    unread: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(50, Math.max(1, query.limit ?? 20));

    const [items, total] = await this.notifications.findAndCount({
      where: query.unreadOnly ? { userId, readAt: IsNull() } : { userId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const unread = await this.notifications.count({
      where: { userId, readAt: IsNull() },
    });

    return { items, total, unread, page, limit };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.notifications.count({ where: { userId, readAt: IsNull() } });
  }

  /** Scoped by userId so one user can never mark another's notification read. */
  async markRead(userId: string, id: string): Promise<Notification> {
    const notification = await this.notifications.findOne({
      where: { id, userId },
    });
    if (!notification) throw new NotFoundException('Notification not found');

    if (!notification.readAt) {
      notification.readAt = new Date();
      await this.notifications.save(notification);
    }
    return notification;
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const result = await this.notifications.update(
      { userId, readAt: IsNull() },
      { readAt: new Date() },
    );
    return { updated: result.affected ?? 0 };
  }
}
