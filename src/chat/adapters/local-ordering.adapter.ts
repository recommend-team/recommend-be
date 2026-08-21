import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Checkout } from '../../modules/orders/entities/checkout.entity';
import { OrderLifecycleService } from '../../modules/orders/order-lifecycle.service';
import { StatusActor } from '../../modules/orders/entities/order-status-event.entity';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { CheckoutService } from '../../modules/orders/checkout.service';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';
import {
  BuyerOrderSummary,
  CartRejection,
  OrderingPort,
  PlaceCheckoutInput,
  PlacedCheckout,
} from '../ports/ordering.port';

/**
 * Thrown when the cart no longer matches reality. The flow catches this and explains
 * the difference as a chat message — a buyer mid-conversation must never meet an HTTP
 * status code.
 */
export class CartChangedError extends Error {
  constructor(readonly rejection: CartRejection) {
    super('CART_CHANGED');
    this.name = 'CartChangedError';
  }
}

/**
 * In-process implementation of `OrderingPort`.
 */
@Injectable()
export class LocalOrderingAdapter implements OrderingPort {
  constructor(
    private readonly checkoutService: CheckoutService,
    private readonly lifecycle: OrderLifecycleService,
    @InjectRepository(Checkout)
    private readonly checkouts: Repository<Checkout>,
  ) {}

  deliveryFeeFor(fulfillmentType: 'PICKUP' | 'DELIVERY'): number {
    return this.checkoutService.deliveryFeeFor(
      fulfillmentType === 'DELIVERY'
        ? FulfillmentType.DELIVERY
        : FulfillmentType.PICKUP,
    );
  }

  async placeCheckout(input: PlaceCheckoutInput): Promise<PlacedCheckout> {
    try {
      const result = await this.checkoutService.createCheckout(
        {
          items: input.lines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            expectedUnitPrice: line.expectedUnitPrice,
          })),
          buyerName: input.buyerName,
          buyerPhone: input.buyerPhone,
          buyerEmail: input.buyerEmail,
          fulfillmentType:
            input.fulfillmentType === 'DELIVERY'
              ? FulfillmentType.DELIVERY
              : FulfillmentType.PICKUP,
          deliveryAddress: input.deliveryAddress,
          notes: input.notes,
        },
        input.createdByAdminId ?? null,
      );

      return {
        checkoutId: result.checkoutId,
        reference: result.reference,
        authorizationUrl: result.authorizationUrl,
        accessCode: result.accessCode,
        paystackPublicKey: result.paystackPublicKey,
        goodsTotal: result.goodsTotal,
        deliveryFee: result.deliveryFee,
        totalAmount: result.totalAmount,
      };
    } catch (error) {
      // Translate the HTTP-shaped rejection into something the conversation can speak.
      if (error instanceof ConflictException) {
        const body = error.getResponse() as Partial<CartRejection>;
        if (body?.code === 'CART_CHANGED') {
          throw new CartChangedError({
            code: 'CART_CHANGED',
            changes: body.changes ?? [],
          });
        }
      }
      throw error;
    }
  }

  async listOrders(references: string[]): Promise<BuyerOrderSummary[]> {
    if (references.length === 0) return [];

    const checkouts = await this.checkouts.find({
      where: { reference: In(references) },
      relations: ['orders', 'orders.items', 'orders.vendor'],
      order: { createdAt: 'DESC' },
    });

    return checkouts.map((checkout) => ({
      reference: checkout.reference,
      status: checkout.status,
      createdAt: checkout.createdAt.toISOString(),
      paidAt: checkout.paidAt ? checkout.paidAt.toISOString() : null,
      fulfillmentType: checkout.fulfillmentType,
      deliveryAddress: checkout.deliveryAddress,
      goodsTotal: Number(checkout.goodsTotal),
      deliveryFee: Number(checkout.deliveryFee),
      totalAmount: Number(checkout.totalAmount),
      // Offered only where confirming receipt is the buyer's next move. A pickup order
      // is theirs to confirm as soon as it is ready; a delivery, once it has left.
      canComplete:
        checkout.status === OrderStatus.DISPATCHED ||
        (checkout.status === OrderStatus.READY &&
          checkout.fulfillmentType === FulfillmentType.PICKUP),
      vendors: (checkout.orders ?? []).map((order) => ({
        vendorName: order.vendor?.businessName ?? null,
        status: order.status,
        items: (order.items ?? []).map((item) => ({
          name: item.productName,
          quantity: item.quantity,
          lineTotal: Number(item.lineTotal),
        })),
      })),
    }));
  }

  async completeOrder(reference: string): Promise<void> {
    await this.lifecycle.markCompleted(reference, {
      type: StatusActor.BUYER,
      // A buyer has no user row until checkout mints one, and the audit trail should
      // not imply otherwise.
      id: null,
    });
  }
}
