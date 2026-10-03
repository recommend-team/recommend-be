import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { In, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { User } from '../auth/entities/auth.entity';
import { Role } from '../../common/enums/roles.enum';
import { PushDelivery, PushService } from './push.service';
import {
  ADMIN_ALERT_EVENT,
  AdminAlertEvent,
  AdminAlertKind,
  CONVERSATION_NEEDS_ATTENTION_EVENT,
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

@Injectable()
export class AdminAlertsService {
  private readonly logger = new Logger(AdminAlertsService.name);

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly pushService: PushService,
    private readonly events: EventEmitter2,
  ) {}

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
   * Socket first, then push. Never throws: an alert that cannot be sent must not unwind
   * whatever caused it — a payment, a refusal, a buyer's message.
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

    try {
      this.events.emit(ADMIN_ALERT_EVENT, event);
    } catch (error) {
      this.logger.error(`Failed to broadcast ${alert.kind}`, error);
    }

    try {
      const recipients = alert.adminId
        ? [alert.adminId]
        : await this.activeAdminIds();

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
