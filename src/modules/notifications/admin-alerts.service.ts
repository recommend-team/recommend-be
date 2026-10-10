import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { User } from '../auth/entities/auth.entity';
import { Role } from '../../common/enums/roles.enum';
import { PushDelivery, PushService } from './push.service';
import { Notification, NotificationType } from './entities/notification.entity';
import {
  ADMIN_ALERT_EVENT,
  AdminAlertEvent,
  AdminAlertKind,
  CONVERSATION_HANDED_OVER_EVENT,
  CONVERSATION_NEEDS_ATTENTION_EVENT,
  ConversationHandedOverEvent,
  ConversationNeedsAttentionEvent,
  HELD_CONVERSATION_MESSAGE_EVENT,
  HeldConversationMessageEvent,
} from '../../common/events/admin-alert.events';
import {
  CHECKOUT_PAID_EVENT,
  CheckoutPaidEvent,
} from '../../common/events/checkout-paid.event';
import {
  WITHDRAWAL_FAILED_EVENT,
  WithdrawalFailedEvent,
} from '../../common/events/wallet.events';
import {
  VENDOR_ORDER_READY_EVENT,
  VendorOrderReadyEvent,
} from '../../common/events/vendor-order-ready.event';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';

interface Alert {
  kind: AdminAlertKind;
  title: string;
  body: string;
  url: string;
  tag: string;
  adminId: string | null;
  delivery: PushDelivery;
}

/** A buyer waiting on a person. Stale within minutes — the assistant takes it back. */
const CONVERSATION_DELIVERY: PushDelivery = {
  urgency: 'high',
  ttlSeconds: 15 * 60,
};

const PREVIEW_LENGTH = 140;

/** How each alert is filed in the notifications feed. */
const FEED_TYPE: Record<AdminAlertKind, NotificationType> = {
  CONVERSATION_HANDED_OVER: NotificationType.ADMIN_CONVERSATION_HANDED_OVER,
  CONVERSATION_FLAGGED: NotificationType.ADMIN_CONVERSATION_FLAGGED,
  HELD_CONVERSATION_MESSAGE: NotificationType.ADMIN_HELD_CONVERSATION_MESSAGE,
  NEW_PAID_ORDER: NotificationType.ADMIN_NEW_PAID_ORDER,
  VENDOR_ORDER_READY: NotificationType.ADMIN_VENDOR_ORDER_READY,
  WITHDRAWAL_FAILED: NotificationType.ADMIN_WITHDRAWAL_FAILED,
};

@Injectable()
export class AdminAlertsService {
  private readonly logger = new Logger(AdminAlertsService.name);

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    private readonly pushService: PushService,
    private readonly events: EventEmitter2,
  ) {}

  /** A buyer asked for a person, and is waiting on one of us. */
  @OnEvent(CONVERSATION_HANDED_OVER_EVENT)
  async onHandedOver(event: ConversationHandedOverEvent): Promise<void> {
    await this.send({
      kind: 'CONVERSATION_HANDED_OVER',
      title: `${event.buyerName ?? 'A buyer'} is waiting for you`,
      body:
        `${event.reason.replace(/\.$/, '')}. ` +
        `They're told the team is busy if nobody takes it in ${event.noticeMinutes} min.`,
      url: `/admin/conversations/${event.conversationId}`,
      tag: `conversation:${event.conversationId}`,
      adminId: null,
      // The chat stays in the queue until someone takes it, so the alert stays worth
      // delivering for a good while.
      delivery: {
        urgency: 'high',
        ttlSeconds: 60 * 60,
      },
    });
  }

  @OnEvent(CONVERSATION_NEEDS_ATTENTION_EVENT)
  async onNeedsAttention(
    event: ConversationNeedsAttentionEvent,
  ): Promise<void> {
    await this.send({
      kind: 'CONVERSATION_FLAGGED',
      title: 'A buyer needs help',
      body: `${event.buyerName ?? 'A buyer'} — ${lowerFirst(event.reason)}.`,
      url: `/admin/conversations/${event.conversationId}`,
      tag: `conversation:${event.conversationId}`,
      adminId: null,
      delivery: CONVERSATION_DELIVERY,
    });
  }

  @OnEvent(HELD_CONVERSATION_MESSAGE_EVENT)
  async onHeldMessage(event: HeldConversationMessageEvent): Promise<void> {
    await this.send({
      kind: 'HELD_CONVERSATION_MESSAGE',
      title: `${event.buyerName ?? 'The buyer'} replied`,
      body: preview(event.text),
      url: `/admin/conversations/${event.conversationId}`,
      tag: `conversation:${event.conversationId}`,
      // Only the admin holding it. Nobody else should be pulled into a conversation that
      // already has someone.
      adminId: event.adminId,
      delivery: CONVERSATION_DELIVERY,
    });
  }

  @OnEvent(CHECKOUT_PAID_EVENT)
  async onCheckoutPaid(event: CheckoutPaidEvent): Promise<void> {
    const vendors = event.orders
      .map((order) => order.vendorName)
      .filter((name): name is string => !!name);

    await this.send({
      kind: 'NEW_PAID_ORDER',
      title: 'New paid order',
      body:
        `${event.buyerName} paid ₦${event.totalAmount.toLocaleString()}` +
        (vendors.length > 0 ? ` — ${vendors.join(', ')}` : '') +
        `. ${event.fulfillmentType === 'DELIVERY' ? 'Delivery' : 'Pickup'}.`,
      url: '/admin/transactions',
      tag: `checkout:${event.reference}`,
      adminId: null,
      delivery: { ttlSeconds: 60 * 60 },
    });
  }

  /**
   * A vendor marked their part ready. Worded by what admin now has to do: the last vendor
   * on a delivery means send a rider; on a pickup it is only news; part of a basket is
   * progress. Tagged with the order, so each update replaces the last on the device.
   */
  @OnEvent(VENDOR_ORDER_READY_EVENT)
  async onVendorReady(event: VendorOrderReadyEvent): Promise<void> {
    const vendor = event.vendorName ?? 'A vendor';
    const allReady = event.readyCount >= event.vendorCount;
    const delivery = event.fulfillmentType === FulfillmentType.DELIVERY;

    const { title, body } = !allReady
      ? {
          title: 'Vendor ready',
          body: `${vendor} has their part of ${event.reference} ready — ${event.readyCount} of ${event.vendorCount} vendors ready.`,
        }
      : delivery
        ? {
            title: 'Ready to dispatch',
            body:
              event.vendorCount > 1
                ? `Every vendor on ${event.reference} is ready (${vendor} was last). Send a rider.`
                : `${vendor} has ${event.reference} ready. Send a rider.`,
          }
        : {
            title: 'Ready for collection',
            body: `${event.reference} is ready — the buyer collects it from ${event.vendorCount > 1 ? 'each vendor' : vendor}.`,
          };

    await this.send({
      kind: 'VENDOR_ORDER_READY',
      title,
      body,
      url: '/admin/transactions',
      tag: `checkout:${event.reference}`,
      adminId: null,
      // A rider to send is urgent; everything else is progress.
      delivery:
        allReady && delivery
          ? { urgency: 'high', ttlSeconds: 2 * 60 * 60 }
          : { ttlSeconds: 60 * 60 },
    });
  }

  @OnEvent(WITHDRAWAL_FAILED_EVENT)
  async onWithdrawalFailed(event: WithdrawalFailedEvent): Promise<void> {
    const vendor = await this.users
      .findOne({ where: { id: event.userId }, select: ['id', 'businessName'] })
      .catch(() => null);

    await this.send({
      kind: 'WITHDRAWAL_FAILED',
      title: event.reversed ? 'Withdrawal reversed' : 'Withdrawal failed',
      // Paystack's own wording, which the vendor is deliberately not shown — admins are
      // the ones who can act on it.
      body:
        `₦${event.amountReturned.toLocaleString()} back in ` +
        `${vendor?.businessName ?? "a vendor's"} wallet (${event.reference}). ` +
        `${event.reason}`,
      url: `/admin/vendors/${event.userId}`,
      tag: `withdrawal:${event.withdrawalId}`,
      adminId: null,
      delivery: {},
    });
  }

  /**
   * The feed, then the socket, then push. Never throws: an alert that cannot be sent must
   * not unwind whatever caused it — a payment, a refusal, a buyer's message.
   *
   * The feed comes first so the bell, refreshing when the socket alert lands, finds the
   * row already there. A feed that cannot be written still lets the socket and push go.
   */
  private async send(alert: Alert): Promise<void> {
    const event = new AdminAlertEvent(
      randomUUID(),
      alert.kind,
      alert.title,
      alert.body,
      alert.url,
      alert.adminId,
      new Date(),
    );

    const recipients: string[] = await (
      alert.adminId ? Promise.resolve([alert.adminId]) : this.activeAdminIds()
    ).catch((error: unknown) => {
      this.logger.error(
        `Failed to find admins for ${alert.kind}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return [];
    });

    await this.keep(alert, event, recipients);

    try {
      this.events.emit(ADMIN_ALERT_EVENT, event);
    } catch (error) {
      this.logger.error(`Failed to broadcast ${alert.kind}`, error);
    }

    try {
      await Promise.all(
        recipients.map((adminId) =>
          this.pushService
            .sendToUser(
              adminId,
              {
                title: alert.title,
                body: alert.body,
                type: alert.kind,
                url: alert.url,
                tag: alert.tag,
                data: { alertId: event.id },
              },
              alert.delivery,
            )
            .catch((error: unknown) => {
              this.logger.warn(`Push failed for admin ${adminId}`, error);
              return 0;
            }),
        ),
      );
    } catch (error) {
      this.logger.error(
        `Failed to push ${alert.kind} to admins: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * One row per admin, so each has their own read state: one admin reading an alert does
   * not clear it from anyone else's bell.
   */
  private async keep(
    alert: Alert,
    event: AdminAlertEvent,
    recipients: string[],
  ): Promise<void> {
    if (recipients.length === 0) return;
    try {
      await this.notifications.insert(
        recipients.map((userId) => ({
          userId,
          type: FEED_TYPE[alert.kind],
          title: alert.title,
          body: alert.body,
          data: { alertId: event.id, kind: alert.kind, url: alert.url },
          readAt: null,
        })),
      );
    } catch (error) {
      this.logger.error(
        `Failed to keep ${alert.kind} in the admin feed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  /** Every admin who can currently sign in — a suspended admin is not paged. */
  private async activeAdminIds(): Promise<string[]> {
    const admins = await this.users.find({
      where: { role: In([Role.ADMIN, Role.SUPER_ADMIN]) },
      select: ['id', 'role', 'status', 'isEmailVerified'],
    });
    return admins.filter((admin) => admin.isActive()).map((admin) => admin.id);
  }
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_LENGTH
    ? `${flat.slice(0, PREVIEW_LENGTH - 1)}…`
    : flat;
}

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}
