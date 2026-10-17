import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Checkout } from './entities/checkout.entity';
import { EmailService } from '../../common/services/email.service';
import {
  CHECKOUT_PAID_EVENT,
  CheckoutPaidEvent,
} from '../../common/events/checkout-paid.event';
import {
  CHECKOUT_STATUS_CHANGED_EVENT,
  CheckoutStatusChangedEvent,
} from '../../common/events/checkout-status-changed.event';
import { OrderStatus } from '../../common/enums/order-status.enum';
import {
  OrderEmailLinks,
  buildOnItsWayEmail,
  buildReceiptEmail,
} from '../../common/emails/order-emails';
import { supportEmail } from '../../common/support';

/** Paystack needs an email; a buyer who gave none is charged under this, and never mailed. */
const PLACEHOLDER_DOMAIN = '@buyers.recommend.ng';

/**
 * Emails the buyer at the two moments that matter: paid (a receipt) and on its way (the
 * delivery code). Every paid order with a real email gets both — from the storefront or
 * the chat alike.
 *
 * Never throws: an email that fails must not fail the payment or the dispatch it reports.
 */
@Injectable()
export class BuyerOrderEmailsListener {
  private readonly logger = new Logger(BuyerOrderEmailsListener.name);

  constructor(
    @InjectRepository(Checkout)
    private readonly checkouts: Repository<Checkout>,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  @OnEvent(CHECKOUT_PAID_EVENT)
  async onPaid(event: CheckoutPaidEvent): Promise<void> {
    if (!isReal(event.buyerEmail)) return;

    await this.send(event.buyerEmail, event.reference, 'receipt', () =>
      buildReceiptEmail(
        {
          buyerName: event.buyerName,
          buyerEmail: event.buyerEmail!,
          reference: event.reference,
          fulfillmentType: event.fulfillmentType,
          deliveryAddress: event.deliveryAddress,
          goodsTotal: event.goodsTotal,
          deliveryFee: event.deliveryFee,
          totalAmount: event.totalAmount,
          vendors: event.orders.map((order) => ({
            vendorName: order.vendorName,
            items: order.items,
          })),
        },
        this.links(),
      ),
    );
  }

  /** On its way — and again on a re-dispatch, which brings a new code. */
  @OnEvent(CHECKOUT_STATUS_CHANGED_EVENT)
  async onStatusChanged(event: CheckoutStatusChangedEvent): Promise<void> {
    if (event.to !== OrderStatus.DISPATCHED || !event.deliveryCode) return;

    try {
      // The event carries no email or rider; the checkout has both.
      const checkout = await this.checkouts.findOne({
        where: { id: event.checkoutId },
        relations: ['rider'],
      });
      if (!checkout || !isReal(checkout.buyerEmail)) return;

      const rider = checkout.rider
        ? {
            name: `${checkout.rider.firstName} ${checkout.rider.lastName}`.trim(),
            phone: checkout.rider.phoneNumber ?? null,
          }
        : null;

      await this.send(checkout.buyerEmail, event.reference, 'on-its-way', () =>
        buildOnItsWayEmail(
          {
            buyerName: event.buyerName,
            buyerEmail: checkout.buyerEmail!,
            reference: event.reference,
            deliveryCode: event.deliveryCode!,
            vendorNames: event.vendorNames,
            rider,
          },
          this.links(),
        ),
      );
    } catch (error) {
      this.logger.error(
        `Could not prepare the on-its-way email for ${event.reference}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  private async send(
    to: string,
    reference: string,
    kind: string,
    build: () => { subject: string; html: string; text: string },
  ): Promise<void> {
    try {
      const email = build();
      await this.email.sendEmail({
        to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        // A reply about an order should reach a person.
        replyTo: {
          email: this.config.get<string>('contact.inbox') ?? supportEmail(),
          name: 'Recommend',
        },
      });
      this.logger.log(`Sent the ${kind} email for ${reference}`);
    } catch (error) {
      this.logger.error(
        `Could not send the ${kind} email for ${reference}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  private links(): OrderEmailLinks {
    const websiteUrl =
      this.config.get<string>('brand.websiteUrl') ??
      'https://recommend-fe.netlify.app';
    return {
      websiteUrl,
      customerAppUrl:
        this.config.get<string>('brand.customerAppUrl') ?? websiteUrl,
    };
  }
}

function isReal(email: string | null | undefined): email is string {
  return !!email && !email.toLowerCase().endsWith(PLACEHOLDER_DOMAIN);
}
