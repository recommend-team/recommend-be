import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Order } from './entities/order.entity';
import { Checkout } from './entities/checkout.entity';
import {
  OrderStatusEvent,
  StatusActor,
} from './entities/order-status-event.entity';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';
import {
  CHECKOUT_STATUS_CHANGED_EVENT,
  CheckoutStatusChangedEvent,
} from '../../common/events/checkout-status-changed.event';
import {
  VENDOR_ORDER_COMPLETED_EVENT,
  VendorOrderCompletedEvent,
} from '../../common/events/vendor-order-completed.event';

/**
 * How far along the lifecycle a status is. Only these participate in the derivation;
 * `CANCELLED`, `REFUNDED` and the vestigial `PROCESSING` are handled explicitly.
 */
const RANK: Partial<Record<OrderStatus, number>> = {
  [OrderStatus.PENDING_PAYMENT]: 0,
  [OrderStatus.PAID]: 1,
  [OrderStatus.READY]: 2,
  [OrderStatus.DISPATCHED]: 3,
  [OrderStatus.COMPLETED]: 4,
};

export interface Actor {
  type: StatusActor;
  /** Null for a buyer, who has no account, and for anything the system did alone. */
  id: string | null;
}

/**
 * Events held back until the transaction commits.
 *
 * Emitting mid-transaction publishes a fact that may still be rolled back, and a listener
 * running on its own connection cannot see the rows anyway. Harmless when the consequence
 * was a chat message; not harmless now that completion credits a wallet.
 */
type Outbox = { name: string; payload: object }[];

/**
 * The order lifecycle.
 */
@Injectable()
export class OrderLifecycleService {
  private readonly logger = new Logger(OrderLifecycleService.name);

  constructor(
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    @InjectRepository(Checkout)
    private readonly checkouts: Repository<Checkout>,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─── Vendor ─────────────────────────────────────────────────────────────────

  /**
   * "I have the goods, a rider can collect." A vendor's only transition.
   *
   * Labelled *Ready for pickup* wherever it is shown — never *Accept*. A button marked
   * Accept gets tapped the moment an order appears, and dispatch sends a rider for food
   * that is not cooked.
   */
  async markReady(orderId: string, vendorId: string): Promise<void> {
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');

    // Checked here rather than trusting a route param — a vendor may only ever touch
    // their own orders, whatever the client sends.
    if (order.vendorId !== vendorId) {
      throw new ForbiddenException('That order belongs to another vendor');
    }

    if (order.status === OrderStatus.READY) return;

    if (order.status !== OrderStatus.PAID) {
      throw new BadRequestException(
        `An order can only be marked ready once it is paid (this one is ${order.status})`,
      );
    }

    const outbox: Outbox = [];
    await this.dataSource.transaction(async (manager) => {
      await this.moveOrder(
        manager,
        order,
        OrderStatus.READY,
        { type: StatusActor.VENDOR, id: vendorId },
        outbox,
        null,
      );
      await this.recomputeCheckout(manager, order.checkoutId, outbox);
    });
    this.flush(outbox);
  }

  // ─── Dispatch and completion ────────────────────────────────────────────────

  /** A rider has collected everything and left. Admin's call — nobody else can know it. */
  async markDispatched(reference: string, actor: Actor): Promise<void> {
    const checkout = await this.loadCheckout(reference);

    if (checkout.status === OrderStatus.DISPATCHED) return;

    if (checkout.fulfillmentType === FulfillmentType.PICKUP) {
      throw new BadRequestException(
        'A pickup order is never dispatched — the buyer collects it',
      );
    }

    if (checkout.status !== OrderStatus.READY) {
      throw new BadRequestException(
        `Every vendor must be ready before dispatch (this order is ${checkout.status})`,
      );
    }

    const outbox: Outbox = [];
    await this.dataSource.transaction(async (manager) => {
      await this.moveCheckout(
        manager,
        checkout,
        OrderStatus.DISPATCHED,
        actor,
        outbox,
      );
    });
    this.flush(outbox);
  }

  /**
   * The buyer has it.
   *
   * Set by the rider who handed it over, the buyer, or admin — never by a timer. A clock
   * marking orders delivered would manufacture a record of deliveries that may never have
   * happened, and that record is exactly what vendor payouts key off.
   */
  async markCompleted(reference: string, actor: Actor): Promise<void> {
    const checkout = await this.loadCheckout(reference);

    if (checkout.status === OrderStatus.COMPLETED) return;

    if (rankOf(checkout.status) < rankOf(OrderStatus.PAID)) {
      throw new BadRequestException(
        'An order that has not been paid for cannot be completed',
      );
    }

    const outbox: Outbox = [];
    await this.dataSource.transaction(async (manager) => {
      await this.moveCheckout(
        manager,
        checkout,
        OrderStatus.COMPLETED,
        actor,
        outbox,
      );

      // Vendor orders follow, so earnings and payout reporting — which read the vendor
      // order, not the checkout — agree with what the buyer was told. Each one that moves
      // is what credits that vendor's wallet.
      for (const order of checkout.orders ?? []) {
        if (order.status !== OrderStatus.COMPLETED) {
          await this.moveOrder(
            manager,
            order,
            OrderStatus.COMPLETED,
            actor,
            outbox,
            checkout.reference,
          );
        }
      }
    });
    this.flush(outbox);
  }

  // ─── Admin override ─────────────────────────────────────────────────────────

  /**
   * Any state to any state, for admin alone.
   *
   * Deliberately unguarded by the transition rules: it exists precisely for the orders
   * those rules have stranded — a vendor who never tapped ready, a rider who never
   * reported back, a decline handled over the phone. The audit row is what keeps it
   * honest, which is why `note` is worth asking for.
   */
  async overrideCheckout(
    reference: string,
    to: OrderStatus,
    adminId: string,
    note?: string,
  ): Promise<void> {
    const checkout = await this.loadCheckout(reference);
    const actor: Actor = { type: StatusActor.ADMIN, id: adminId };

    const outbox: Outbox = [];
    await this.dataSource.transaction(async (manager) => {
      await this.moveCheckout(manager, checkout, to, actor, outbox, note);

      // Terminal states are about the whole purchase, so the vendor orders go with it.
      // Anything mid-lifecycle is left alone: a vendor's own progress is still true.
      if (
        to === OrderStatus.COMPLETED ||
        to === OrderStatus.CANCELLED ||
        to === OrderStatus.REFUNDED
      ) {
        for (const order of checkout.orders ?? []) {
          if (order.status !== to) {
            await this.moveOrder(
              manager,
              order,
              to,
              actor,
              outbox,
              checkout.reference,
              note,
            );
          }
        }
      }
    });
    this.flush(outbox);
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private async loadCheckout(reference: string): Promise<Checkout> {
    const checkout = await this.checkouts.findOne({
      where: { reference },
      relations: ['orders', 'orders.items', 'orders.vendor'],
    });
    if (!checkout) throw new NotFoundException('Order not found');
    return checkout;
  }

  private async moveOrder(
    manager: EntityManager,
    order: Order,
    to: OrderStatus,
    actor: Actor,
    outbox: Outbox,
    /** The buyer's charge reference. Null where the transition cannot be a completion. */
    reference: string | null,
    note?: string,
  ): Promise<void> {
    const from = order.status;
    await manager.update(Order, { id: order.id }, { status: to });
    await manager.insert(OrderStatusEvent, {
      orderId: order.id,
      checkoutId: order.checkoutId,
      fromStatus: from,
      toStatus: to,
      actorType: actor.type,
      actorId: actor.id,
      note: note ?? null,
    });
    order.status = to;

    // The vendor has delivered, so this is the moment they have earned the money. The
    // figures are the snapshots on the row, cast because `decimal` reaches us as strings.
    if (to === OrderStatus.COMPLETED && from !== OrderStatus.COMPLETED) {
      if (!reference) {
        this.logger.error(
          `Order ${order.id} completed without a reference — no wallet credit published`,
        );
        return;
      }
      outbox.push({
        name: VENDOR_ORDER_COMPLETED_EVENT,
        payload: new VendorOrderCompletedEvent(
          order.id,
          order.checkoutId,
          order.vendorId,
          reference,
          Number(order.totalAmount),
          Number(order.platformFee),
          Number(order.vendorAmount),
        ),
      });
    }
  }

  /** Writes the checkout, records it, and queues the announcement — in that order. */
  private async moveCheckout(
    manager: EntityManager,
    checkout: Checkout,
    to: OrderStatus,
    actor: Actor,
    outbox: Outbox,
    note?: string,
  ): Promise<void> {
    const from = checkout.status;
    if (from === to) return;

    await manager.update(Checkout, { id: checkout.id }, { status: to });
    await manager.insert(OrderStatusEvent, {
      orderId: null,
      checkoutId: checkout.id,
      fromStatus: from,
      toStatus: to,
      actorType: actor.type,
      actorId: actor.id,
      note: note ?? null,
    });
    checkout.status = to;

    outbox.push({
      name: CHECKOUT_STATUS_CHANGED_EVENT,
      payload: new CheckoutStatusChangedEvent(
        checkout.id,
        checkout.reference,
        checkout.buyerName,
        checkout.buyerPhone,
        checkout.fulfillmentType,
        from,
        to,
        (checkout.orders ?? []).flatMap((order) =>
          (order.items ?? []).map((item) => ({
            name: item.productName,
            quantity: item.quantity,
          })),
        ),
        (checkout.orders ?? [])
          .map((order) => order.vendor?.businessName)
          .filter((name): name is string => !!name),
      ),
    });
  }

  /**
   * Pull the checkout up to whatever its slowest vendor has reached.
   *
   * Never backwards, and never past a checkout-level state: once a rider has the goods,
   * a vendor editing their own order says nothing about where the parcel is.
   */
  private async recomputeCheckout(
    manager: EntityManager,
    checkoutId: string,
    outbox: Outbox,
  ): Promise<void> {
    const checkout = await manager.findOne(Checkout, {
      where: { id: checkoutId },
      relations: ['orders', 'orders.items', 'orders.vendor'],
    });
    if (!checkout) return;

    if (rankOf(checkout.status) >= rankOf(OrderStatus.DISPATCHED)) return;

    const active = (checkout.orders ?? []).filter(
      (order) => order.status !== OrderStatus.CANCELLED,
    );
    if (active.length === 0) return;

    const slowest = active.reduce(
      (lowest, order) => Math.min(lowest, rankOf(order.status)),
      Number.POSITIVE_INFINITY,
    );

    const derived = statusForRank(slowest);
    if (!derived || derived === checkout.status) return;
    if (rankOf(derived) <= rankOf(checkout.status)) return;

    await this.moveCheckout(
      manager,
      checkout,
      derived,
      { type: StatusActor.SYSTEM, id: null },
      outbox,
    );
  }

  /**
   * Publish what the committed transaction produced.
   *
   * Each event is isolated: one listener throwing must not swallow the events behind it,
   * and none of them can undo a status change that is already durable.
   */
  private flush(outbox: Outbox): void {
    for (const { name, payload } of outbox) {
      try {
        this.eventEmitter.emit(name, payload);
      } catch (error) {
        this.logger.error(
          `Failed to publish ${name}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }
}

function rankOf(status: OrderStatus): number {
  return RANK[status] ?? -1;
}

function statusForRank(rank: number): OrderStatus | null {
  const found = Object.entries(RANK).find(([, value]) => value === rank);
  return found ? (found[0] as OrderStatus) : null;
}
