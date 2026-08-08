import { ConflictException, Injectable } from '@nestjs/common';
import { CheckoutService } from '../../modules/orders/checkout.service';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';
import {
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
  constructor(private readonly checkoutService: CheckoutService) {}

  async placeCheckout(input: PlaceCheckoutInput): Promise<PlacedCheckout> {
    try {
      const result = await this.checkoutService.createCheckout({
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
      });

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
}
