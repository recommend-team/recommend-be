import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConversationService } from '../../conversation/conversation.service';
import {
  Conversation,
  PendingCartLine,
} from '../../conversation/entities/conversation.entity';
import { ConversationState } from '../../enums/chat.enums';
import { OutboundMessage } from '../../transport/channel.interface';
import { ORDERING_PORT } from '../../ports/ordering.port';
import type { OrderingPort } from '../../ports/ordering.port';
import { IDENTITY_PORT } from '../../ports/identity.port';
import type { IdentityPort } from '../../ports/identity.port';
import { CATALOG_PORT } from '../../ports/catalog.port';
import type { CatalogPort } from '../../ports/catalog.port';
import { CartChangedError } from '../../adapters/local-ordering.adapter';
import { formatForDisplay, formatNaira, toE164 } from '../../utils/phone.util';

/**
 * The money path, as a conversation.
 */
@Injectable()
export class CheckoutFlow {
  private readonly logger = new Logger(CheckoutFlow.name);

  constructor(
    private readonly conversationService: ConversationService,
    @Inject(ORDERING_PORT) private readonly ordering: OrderingPort,
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    @Inject(CATALOG_PORT) private readonly catalog: CatalogPort,
  ) {}

  /** Entry point — the buyer tapped Pay. */
  async start(
    conversation: Conversation,
    cart: PendingCartLine[],
  ): Promise<OutboundMessage[]> {
    if (cart.length === 0) {
      return [
        {
          text: "Your cart is empty — tell me what you'd like and I'll find it.",
        },
      ];
    }

    await this.conversationService.mergeContext(conversation.id, {
      pendingCart: cart,
    });

    // Re-order within one conversation shouldn't re-ask for what we already know.
    return this.advanceFrom(conversation, ConversationState.COLLECTING_NAME);
  }

  /** Every buyer message while a checkout is in progress. */
  async handle(
    conversation: Conversation,
    text: string,
  ): Promise<OutboundMessage[]> {
    const answer = text.trim();

    if (isAbandon(answer)) {
      await this.reset(conversation.id);
      return [
        {
          text: "No problem — I've set that aside. Your cart is still here whenever you want it.",
        },
      ];
    }

    switch (conversation.state) {
      case ConversationState.COLLECTING_NAME:
        return this.captureName(conversation, answer);
      case ConversationState.COLLECTING_PHONE:
        return this.capturePhone(conversation, answer);
      case ConversationState.COLLECTING_FULFILLMENT:
        return this.captureFulfillment(conversation, answer);
      case ConversationState.COLLECTING_ADDRESS:
        return this.captureAddress(conversation, answer);
      case ConversationState.CONFIRMING_ORDER:
        return this.confirm(conversation, answer);
      case ConversationState.AWAITING_PAYMENT:
        return [
          {
            text: "I'm still waiting for the payment to go through. Once it does I'll confirm your order here.",
          },
        ];
      default:
        // Unreachable via the engine, but a stale state must not strand anyone.
        await this.reset(conversation.id);
        return [{ text: "Let's start again — what would you like to order?" }];
    }
  }

  // ─── Steps ──────────────────────────────────────────────────────────────────

  private async captureName(
    conversation: Conversation,
    answer: string,
  ): Promise<OutboundMessage[]> {
    if (answer.length < 2) {
      return [{ text: 'Sorry, what name should I put on the order?' }];
    }

    await this.conversationService.mergeContext(conversation.id, {
      profile: { name: answer },
    });
    return this.advanceFrom(conversation, ConversationState.COLLECTING_PHONE);
  }

  private async capturePhone(
    conversation: Conversation,
    answer: string,
  ): Promise<OutboundMessage[]> {
    const phone = toE164(answer);

    if (!phone) {
      // Re-ask rather than advance — checkout requires strict E.164 and would reject it.
      return [
        {
          text: "That doesn't look like a complete phone number. Something like 0801 234 5678?",
        },
      ];
    }

    await this.conversationService.mergeContext(conversation.id, {
      profile: { phone },
    });
    return this.advanceFrom(
      conversation,
      ConversationState.COLLECTING_FULFILLMENT,
    );
  }

  private async captureFulfillment(
    conversation: Conversation,
    answer: string,
  ): Promise<OutboundMessage[]> {
    const choice = readFulfillment(answer);

    if (!choice) {
      return [
        {
          text: 'Would you like it delivered, or will you pick it up?',
          payload: fulfillmentChoices(),
        },
      ];
    }

    await this.conversationService.mergeContext(conversation.id, {
      profile: { fulfillmentType: choice },
    });

    return this.advanceFrom(
      conversation,
      choice === 'DELIVERY'
        ? ConversationState.COLLECTING_ADDRESS
        : ConversationState.CONFIRMING_ORDER,
    );
  }

  private async captureAddress(
    conversation: Conversation,
    answer: string,
  ): Promise<OutboundMessage[]> {
    if (answer.length < 5) {
      return [
        {
          text: 'I need a bit more of the address than that — street and area?',
        },
      ];
    }

    await this.conversationService.mergeContext(conversation.id, {
      profile: { address: answer },
    });
    return this.advanceFrom(conversation, ConversationState.CONFIRMING_ORDER);
  }

  private async confirm(
    conversation: Conversation,
    answer: string,
  ): Promise<OutboundMessage[]> {
    if (isNegative(answer)) {
      await this.reset(conversation.id);
      return [
        {
          text: 'Fine — nothing has been charged. What would you like to change?',
        },
      ];
    }

    if (!isAffirmative(answer)) {
      return [
        {
          text: 'Shall I go ahead with this order?',
          payload: confirmChoices(),
        },
      ];
    }

    return this.placeOrder(conversation);
  }

  // ─── Placing the order ──────────────────────────────────────────────────────

  private async placeOrder(
    conversation: Conversation,
  ): Promise<OutboundMessage[]> {
    const fresh = await this.conversationService.findById(conversation.id);
    const profile = fresh?.context?.profile;
    const cart = fresh?.context?.pendingCart ?? [];

    if (!profile?.name || !profile.phone || cart.length === 0) {
      await this.reset(conversation.id);
      return [
        { text: "Something went missing there — let's start the order again." },
      ];
    }

    try {
      // The buyer's details become a real record only now, at the point of purchase.
      const { buyerId } = await this.identity.upsertBuyer({
        name: profile.name,
        phone: profile.phone,
        email: profile.email,
        address: profile.address,
      });

      const placed = await this.ordering.placeCheckout({
        lines: cart,
        buyerId,
        buyerName: profile.name,
        buyerPhone: profile.phone,
        buyerEmail: profile.email,
        fulfillmentType:
          profile.fulfillmentType === 'DELIVERY' ? 'DELIVERY' : 'PICKUP',
        deliveryAddress: profile.address,
      });

      await this.conversationService.mergeContext(conversation.id, {
        pendingCheckoutId: placed.checkoutId,
        pendingPaymentReference: placed.reference,
      });
      await this.conversationService.setState(
        conversation.id,
        ConversationState.AWAITING_PAYMENT,
      );

      return [
        {
          text: `That's ${formatNaira(placed.totalAmount)} altogether. Tap below to pay — you won't leave this chat.`,
          payload: {
            kind: 'payment_link',
            data: {
              reference: placed.reference,
              // Inline payment opens over the conversation instead of navigating away.
              accessCode: placed.accessCode,
              publicKey: placed.paystackPublicKey,
              // Redirect fallback for any client that cannot open inline.
              authorizationUrl: placed.authorizationUrl,
              goodsTotal: placed.goodsTotal,
              deliveryFee: placed.deliveryFee,
              totalAmount: placed.totalAmount,
            },
          },
        },
      ];
    } catch (error) {
      if (error instanceof CartChangedError) {
        await this.reset(conversation.id);
        return [{ text: describeCartChanges(error) }];
      }

      this.logger.error(
        `Checkout failed for conversation ${conversation.id}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      await this.reset(conversation.id);
      return [
        {
          text: "I couldn't set up the payment just then. Nothing has been charged — shall we try again?",
        },
      ];
    }
  }

  // ─── State movement ─────────────────────────────────────────────────────────

  /**
   * Move to `target`, skipping any step already answered, and ask for whatever the new
   * state needs. Skipping is what makes a second order in the same conversation quick.
   */
  private async advanceFrom(
    conversation: Conversation,
    target: ConversationState,
  ): Promise<OutboundMessage[]> {
    const fresh = await this.conversationService.findById(conversation.id);
    const profile = fresh?.context?.profile ?? {};
    let state = target;

    if (state === ConversationState.COLLECTING_NAME && profile.name) {
      state = ConversationState.COLLECTING_PHONE;
    }
    if (state === ConversationState.COLLECTING_PHONE && profile.phone) {
      state = ConversationState.COLLECTING_FULFILLMENT;
    }
    if (
      state === ConversationState.COLLECTING_ADDRESS &&
      profile.address &&
      profile.fulfillmentType === 'DELIVERY'
    ) {
      state = ConversationState.CONFIRMING_ORDER;
    }

    await this.conversationService.setState(conversation.id, state);

    return state === ConversationState.CONFIRMING_ORDER
      ? this.summarise(fresh ?? conversation)
      : [promptFor(state, profile.name)];
  }

  /** Read the order back before charging for it, priced from the database. */
  private async summarise(
    conversation: Conversation,
  ): Promise<OutboundMessage[]> {
    const cart = conversation.context?.pendingCart ?? [];
    const profile = conversation.context?.profile ?? {};

    const lines = await Promise.all(
      cart.map(async (line) => {
        const product = await this.catalog.getProductById(line.productId);
        return product
          ? {
              name: product.name,
              vendorName: product.vendorName,
              quantity: line.quantity,
              unitPrice: product.price,
              lineTotal: round2(product.price * line.quantity),
            }
          : null;
      }),
    );

    const items = lines.filter(
      (line): line is NonNullable<typeof line> => !!line,
    );
    const goodsTotal = round2(
      items.reduce((sum, item) => sum + item.lineTotal, 0),
    );

    const readable = items
      .map((item) => `${item.quantity} × ${item.name}`)
      .join(', ');

    return [
      {
        text:
          `So that's ${readable}, ${goodsTotal ? `${formatNaira(goodsTotal)} for the food` : ''}` +
          `${profile.fulfillmentType === 'DELIVERY' ? `, delivered to ${profile.address ?? 'your address'}` : ', for pickup'}` +
          `. Delivery fee and total are shown below. Shall I go ahead?`,
        payload: {
          kind: 'order_summary',
          data: {
            status: 'PENDING_CONFIRMATION',
            items,
            goodsTotal,
            fulfillmentType: profile.fulfillmentType ?? 'PICKUP',
            deliveryAddress: profile.address ?? null,
            buyerName: profile.name ?? null,
            buyerPhone: profile.phone ? formatForDisplay(profile.phone) : null,
          },
        },
      },
    ];
  }

  /** Clear the flow without losing the profile — a second order shouldn't re-ask. */
  private async reset(conversationId: string): Promise<void> {
    await this.conversationService.mergeContext(conversationId, {
      pendingCart: [],
    });
    await this.conversationService.setState(
      conversationId,
      ConversationState.DISCOVERY,
    );
  }
}

// ─── Wording and parsing ──────────────────────────────────────────────────────

function promptFor(state: ConversationState, name?: string): OutboundMessage {
  switch (state) {
    case ConversationState.COLLECTING_NAME:
      return { text: 'Lovely. What name should I put on the order?' };
    case ConversationState.COLLECTING_PHONE:
      return {
        text: `Thanks${name ? `, ${name.split(' ')[0]}` : ''}. What phone number should the vendor call?`,
      };
    case ConversationState.COLLECTING_FULFILLMENT:
      return {
        text: 'Would you like it delivered, or will you pick it up?',
        payload: fulfillmentChoices(),
      };
    case ConversationState.COLLECTING_ADDRESS:
      return { text: 'Where should we deliver it?' };
    default:
      return { text: 'Shall I go ahead?' };
  }
}

function fulfillmentChoices() {
  return {
    kind: 'choices' as const,
    data: {
      purpose: 'fulfillment',
      options: [
        { id: 'DELIVERY', label: 'Deliver to me' },
        { id: 'PICKUP', label: "I'll pick it up" },
      ],
    },
  };
}

function confirmChoices() {
  return {
    kind: 'choices' as const,
    data: {
      purpose: 'confirm',
      options: [
        { id: 'yes', label: 'Yes, go ahead' },
        { id: 'no', label: 'Not yet' },
      ],
    },
  };
}

/**
 * Buyers mostly tap the `choices` buttons, so this is the fallback for those who type.
 * It has to cope with "I'll pick it up" and "come carry am" as readily as "pickup" —
 * anything it cannot read is re-asked rather than guessed, because guessing here means
 * delivering food to someone who meant to collect it.
 */
function readFulfillment(answer: string): 'DELIVERY' | 'PICKUP' | null {
  const text = answer.toLowerCase();

  if (/\b(deliver|delivery|bring|send|drop\s*(it)?\s*off)\b/.test(text)) {
    return 'DELIVERY';
  }
  if (
    /\bpick\s*(it|them|am)?\s*up\b|\bpickup\b|\bcollect\b|\bmyself\b|\bcome\s+(and\s+)?(get|carry|take|pick)\b/.test(
      text,
    )
  ) {
    return 'PICKUP';
  }
  return null;
}

function isAffirmative(answer: string): boolean {
  return /^(yes|yeah|yep|ok|okay|sure|go ahead|please do|confirm|y)\b/i.test(
    answer.trim(),
  );
}

function isNegative(answer: string): boolean {
  return /^(no|nope|not yet|wait|hold on|n)\b/i.test(answer.trim());
}

function isAbandon(answer: string): boolean {
  return /\b(cancel|stop|forget it|never mind|nevermind|add (more|something))\b/i.test(
    answer,
  );
}

/** Turn a rejected cart into something a buyer can act on. */
function describeCartChanges(error: CartChangedError): string {
  const parts = error.rejection.changes.map((change) => {
    const name = change.productName ?? 'An item';
    switch (change.reason) {
      case 'PRICE_CHANGED':
        return `${name} is now ${formatNaira(change.currentUnitPrice ?? 0)}`;
      case 'VENDOR_CLOSED':
        return `${name} — that kitchen has closed`;
      case 'UNAVAILABLE':
        return `${name} has sold out`;
      default:
        return `${name} is no longer available`;
    }
  });

  return `Something changed while we were talking: ${parts.join('; ')}. Nothing has been charged — shall we sort the cart out?`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
