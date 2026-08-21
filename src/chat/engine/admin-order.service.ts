import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConversationService } from '../conversation/conversation.service';
import { CartChangedError } from '../adapters/local-ordering.adapter';
import { ORDERING_PORT } from '../ports/ordering.port';
import type {
  CartLine,
  OrderingPort,
  PlacedCheckout,
} from '../ports/ordering.port';

export interface AdminOrderInput {
  lines: CartLine[];
  /** Each optional — anything the conversation already knows is not asked for again. */
  buyerName?: string;
  buyerPhone?: string;
  buyerEmail?: string;
  fulfillmentType?: 'PICKUP' | 'DELIVERY';
  deliveryAddress?: string;
  notes?: string;
}

@Injectable()
export class AdminOrderService {
  private readonly logger = new Logger(AdminOrderService.name);

  constructor(
    @Inject(ORDERING_PORT) private readonly ordering: OrderingPort,
    private readonly conversations: ConversationService,
  ) {}

  async place(
    conversationId: string,
    adminId: string,
    input: AdminOrderInput,
  ): Promise<PlacedCheckout> {
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) throw new NotFoundException('Conversation not found');

    if (conversation.heldByAdminId !== adminId) {
      throw new ConflictException(
        'Take the conversation before ordering for the buyer.',
      );
    }

    const context = conversation.context ?? {};
    if (context.pendingPaymentReference) {
      throw new ConflictException(
        'This buyer already has a payment waiting. Confirm or abandon it first.',
      );
    }

    if (input.lines.length === 0) {
      throw new BadRequestException('Add at least one item');
    }

    const profile = context.profile ?? {};
    const buyerName = input.buyerName ?? profile.name;
    const buyerPhone = input.buyerPhone ?? profile.phone;
    const buyerEmail = input.buyerEmail ?? profile.email;
    const fulfillmentType =
      input.fulfillmentType ?? profile.fulfillmentType ?? 'DELIVERY';
    const deliveryAddress = input.deliveryAddress ?? profile.address;

    if (!buyerName) throw new BadRequestException('A buyer name is required');
    if (!buyerPhone) throw new BadRequestException('A buyer phone is required');
    if (fulfillmentType === 'DELIVERY' && !deliveryAddress) {
      throw new BadRequestException(
        'A delivery address is required for a delivery order',
      );
    }

    const placed = await this.placeOrTranslate({
      lines: input.lines,
      buyerId: conversation.buyerId ?? null,
      buyerName,
      buyerPhone,
      buyerEmail,
      fulfillmentType,
      deliveryAddress,
      notes: input.notes,
      createdByAdminId: adminId,
    });

    // The three fields a buyer's own checkout writes, for the same reasons.
    //
    // `orderReferences` is the one that matters most: the buyer's Orders tab reads only
    // from it, and `EngineService.completeOrder` refuses any reference missing from it.
    // Forget this and the customer can neither see the order nor confirm receiving it —
    // and confirming receipt is what releases the vendor's money.
    const history = context.orderReferences ?? [];

    await this.conversations.mergeContext(conversationId, {
      // Whatever the admin typed is now what we know about this buyer. It is also what
      // `findForCheckout` falls back to when matching a thread by phone.
      profile: {
        name: buyerName,
        phone: buyerPhone,
        email: buyerEmail,
        fulfillmentType,
        address: deliveryAddress,
      },
      pendingCheckoutId: placed.checkoutId,
      pendingPaymentReference: placed.reference,
      orderReferences: [...history, placed.reference],
    });

    // State is deliberately untouched. The assistant is already silent while the
    // conversation is held, handback resets it, and the payment listener sets DISCOVERY
    // when the money lands — so AWAITING_PAYMENT here would only fight takeover.

    this.logger.log(
      `Admin ${adminId} placed ${placed.reference} for conversation ${conversationId}`,
    );

    return placed;
  }

  /**
   * A cart that no longer matches reality arrives as a plain error from the adapter, so
   * the flow can phrase it as chat. An admin is on an HTTP call and should get the same
   * 409 the storefront gets, with the changes intact.
   */
  private async placeOrTranslate(
    input: Parameters<OrderingPort['placeCheckout']>[0],
  ): Promise<PlacedCheckout> {
    try {
      return await this.ordering.placeCheckout(input);
    } catch (error) {
      if (error instanceof CartChangedError) {
        throw new ConflictException(error.rejection);
      }
      throw error;
    }
  }
}
