import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Order } from './entities/order.entity';
import { Checkout } from './entities/checkout.entity';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus } from '../../common/enums/order-status.enum';
import {
  CHECKOUT_PAID_EVENT,
  CheckoutPaidEvent,
} from '../../common/events/checkout-paid.event';

export interface PaginatedOrders {
  items: Order[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface EarningsSummary {
  grossTotal: number;
  netTotal: number;
  platformFeeTotal: number;
  monthlyBreakdown: { month: string; gross: number; net: number }[];
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(Order)
    private readonly ordersRepository: Repository<Order>,
    @InjectRepository(Checkout)
    private readonly checkoutsRepository: Repository<Checkout>,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─── Webhook handler ────────────────────────────────────────────────────────

  /**
   * One Paystack charge settles the whole basket, so a single reference marks the
   * checkout and every vendor's order paid together. Idempotent — Paystack retries
   * webhooks, and a second delivery must not re-stamp paidAt.
   */
  async handlePaymentSuccess(reference: string): Promise<void> {
    const checkout = await this.checkoutsRepository.findOne({
      where: { reference },
      relations: ['orders'],
    });

    if (!checkout) {
      this.logger.warn(
        `Webhook: checkout not found for reference ${reference}`,
      );
      return;
    }

    if (checkout.status !== OrderStatus.PENDING_PAYMENT) {
      this.logger.warn(
        `Webhook: checkout ${checkout.id} already processed (status=${checkout.status})`,
      );
      return;
    }

    const paidAt = new Date();

    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        Checkout,
        { id: checkout.id },
        { status: OrderStatus.PAID, paidAt },
      );
      await manager.update(
        Order,
        { checkoutId: checkout.id, status: OrderStatus.PENDING_PAYMENT },
        { status: OrderStatus.PAID, paidAt },
      );
    });

    this.logger.log(
      `Checkout ${checkout.id} paid — ${checkout.orders?.length ?? 0} vendor order(s) marked PAID (ref=${reference})`,
    );

    // Emitted after the state change is committed, so every listener sees a paid
    // checkout. Listeners handle their own failures — a notification that cannot be
    // delivered must never make the webhook look like it failed, or Paystack will
    // retry a payment we have already recorded.
    await this.publishPaidEvent(checkout.id, paidAt);
  }

  private async publishPaidEvent(
    checkoutId: string,
    paidAt: Date,
  ): Promise<void> {
    try {
      const checkout = await this.checkoutsRepository.findOne({
        where: { id: checkoutId },
        relations: ['orders', 'orders.items'],
      });
      if (!checkout) return;

      this.eventEmitter.emit(
        CHECKOUT_PAID_EVENT,
        new CheckoutPaidEvent(
          checkout.id,
          checkout.reference,
          checkout.buyerName,
          checkout.buyerPhone,
          checkout.buyerEmail,
          checkout.fulfillmentType,
          checkout.deliveryAddress,
          Number(checkout.goodsTotal),
          Number(checkout.deliveryFee),
          Number(checkout.totalAmount),
          (checkout.orders ?? []).map((order) => ({
            orderId: order.id,
            vendorId: order.vendorId,
            subtotal: Number(order.totalAmount),
            vendorAmount: Number(order.vendorAmount),
            items: (order.items ?? []).map((item) => ({
              name: item.productName,
              quantity: item.quantity,
            })),
          })),
          paidAt,
        ),
      );
    } catch (error) {
      this.logger.error(
        `Failed to publish ${CHECKOUT_PAID_EVENT} for ${checkoutId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  // ─── Buyer view ─────────────────────────────────────────────────────────────

  /**
   * Order status by reference, for the buyer who just paid.
   *
   * Public and keyed on the reference alone, so it deliberately exposes nothing a
   * buyer would not already be holding: no phone number, no email, no address —
   * just what they ordered and where it is.
   */
  async getCheckoutStatus(reference: string): Promise<{
    reference: string;
    status: OrderStatus;
    paidAt: Date | null;
    goodsTotal: number;
    deliveryFee: number;
    totalAmount: number;
    fulfillmentType: string;
    createdAt: Date;
    vendors: {
      status: OrderStatus;
      items: { name: string; quantity: number; unitPrice: number }[];
    }[];
  }> {
    const checkout = await this.checkoutsRepository.findOne({
      where: { reference },
      relations: ['orders', 'orders.items'],
    });

    if (!checkout) throw new NotFoundException('Order not found');

    return {
      reference: checkout.reference,
      status: checkout.status,
      paidAt: checkout.paidAt,
      goodsTotal: Number(checkout.goodsTotal),
      deliveryFee: Number(checkout.deliveryFee),
      totalAmount: Number(checkout.totalAmount),
      fulfillmentType: checkout.fulfillmentType,
      createdAt: checkout.createdAt,
      vendors: (checkout.orders ?? []).map((order) => ({
        status: order.status,
        items: (order.items ?? []).map((item) => ({
          name: item.productName,
          quantity: item.quantity,
          unitPrice: Number(item.unitPrice),
        })),
      })),
    };
  }

  // ─── Vendor views ───────────────────────────────────────────────────────────

  async getVendorOrders(
    vendorId: string,
    query: { status?: OrderStatus; page?: number; limit?: number },
  ): Promise<{ message: string; data: PaginatedOrders }> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(50, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { vendorId };
    if (query.status) where['status'] = query.status;

    const [items, total] = await this.ordersRepository.findAndCount({
      where,
      relations: ['items'],
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return {
      message: 'Orders retrieved successfully',
      data: {
        items,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getVendorEarnings(
    vendorId: string,
  ): Promise<{ message: string; data: EarningsSummary }> {
    // Only count PAID and COMPLETED orders
    const paidStatuses = [OrderStatus.PAID, OrderStatus.COMPLETED];

    const rows = await this.ordersRepository
      .createQueryBuilder('order')
      .select([
        'order.totalAmount',
        'order.vendorAmount',
        'order.platformFee',
        "TO_CHAR(order.paidAt, 'YYYY-MM') AS month",
      ])
      .where('order.vendorId = :vendorId', { vendorId })
      .andWhere('order.status IN (:...statuses)', { statuses: paidStatuses })
      .andWhere('order.paidAt IS NOT NULL')
      .getRawMany<{
        order_totalAmount: string;
        order_vendorAmount: string;
        order_platformFee: string;
        month: string;
      }>();

    let grossTotal = 0;
    let netTotal = 0;
    let platformFeeTotal = 0;

    const monthMap: Record<string, { gross: number; net: number }> = {};

    for (const row of rows) {
      const gross = parseFloat(row.order_totalAmount);
      const net = parseFloat(row.order_vendorAmount);
      const fee = parseFloat(row.order_platformFee);

      grossTotal += gross;
      netTotal += net;
      platformFeeTotal += fee;

      const m = row.month;
      if (!monthMap[m]) monthMap[m] = { gross: 0, net: 0 };
      monthMap[m].gross = parseFloat((monthMap[m].gross + gross).toFixed(2));
      monthMap[m].net = parseFloat((monthMap[m].net + net).toFixed(2));
    }

    // Last 12 months sorted descending
    const monthlyBreakdown = Object.entries(monthMap)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 12)
      .map(([month, { gross, net }]) => ({ month, gross, net }));

    return {
      message: 'Earnings retrieved successfully',
      data: {
        grossTotal: parseFloat(grossTotal.toFixed(2)),
        netTotal: parseFloat(netTotal.toFixed(2)),
        platformFeeTotal: parseFloat(platformFeeTotal.toFixed(2)),
        monthlyBreakdown,
      },
    };
  }
}
