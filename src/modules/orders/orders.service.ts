import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from './entities/order.entity';
import { Product } from '../products/entities/product.entity';
import { PaymentsService } from '../payments/payments.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { randomBytes } from 'crypto';

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
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    private readonly paymentsService: PaymentsService,
  ) {}

  // ─── Order creation ─────────────────────────────────────────────────────────

  async createOrder(dto: CreateOrderDto): Promise<{
    message: string;
    data: { orderId: string; authorizationUrl: string; reference: string };
  }> {
    // 1. Validate product
    const product = await this.productsRepository.findOne({
      where: { id: dto.productId },
    });
    if (!product) throw new NotFoundException('Product not found');
    if (!product.isAvailable) {
      throw new BadRequestException('This product is currently unavailable');
    }

    // 2. Compute amounts
    const unitPrice = Number(product.price);
    const totalAmount = parseFloat((unitPrice * dto.quantity).toFixed(2));
    const platformFee = parseFloat((totalAmount * 0.2).toFixed(2));
    const vendorAmount = parseFloat((totalAmount - platformFee).toFixed(2));

    // 3. Generate a unique Paystack reference
    const reference = `REC-${randomBytes(8).toString('hex').toUpperCase()}`;

    // 4. Create order in PENDING_PAYMENT status
    const order = this.ordersRepository.create({
      productId: dto.productId,
      vendorId: product.vendorId,
      buyerPhone: dto.buyerPhone,
      buyerName: dto.buyerName,
      buyerEmail: dto.buyerEmail ?? null,
      quantity: dto.quantity,
      unitPrice,
      totalAmount,
      platformFee,
      vendorAmount,
      fulfillmentType: dto.fulfillmentType,
      status: OrderStatus.PENDING_PAYMENT,
      paymentReference: reference,
      deliveryAddress: dto.deliveryAddress ?? null,
      notes: dto.notes ?? null,
    });
    const saved = await this.ordersRepository.save(order);

    // 5. Initialize Paystack payment
    // Use buyer email or a placeholder (Paystack requires an email)
    const payerEmail =
      dto.buyerEmail ??
      `${dto.buyerPhone.replace('+', '')}@whatsapp.recommend.app`;

    const { authorizationUrl } = await this.paymentsService.initializePayment({
      email: payerEmail,
      amountNgn: totalAmount,
      reference,
      metadata: {
        orderId: saved.id,
        productId: dto.productId,
        buyerName: dto.buyerName,
        buyerPhone: dto.buyerPhone,
      },
    });

    return {
      message: 'Order created. Complete payment to confirm your order.',
      data: { orderId: saved.id, authorizationUrl, reference },
    };
  }

  // ─── Webhook handler ────────────────────────────────────────────────────────

  async handlePaymentSuccess(reference: string): Promise<void> {
    const order = await this.ordersRepository.findOne({
      where: { paymentReference: reference },
    });

    if (!order) {
      this.logger.warn(`Webhook: order not found for reference ${reference}`);
      return;
    }

    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      this.logger.warn(
        `Webhook: order ${order.id} already processed (status=${order.status})`,
      );
      return;
    }

    order.status = OrderStatus.PAID;
    order.paidAt = new Date();
    await this.ordersRepository.save(order);

    this.logger.log(`Order ${order.id} marked as PAID (ref=${reference})`);
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
      relations: ['product'],
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
