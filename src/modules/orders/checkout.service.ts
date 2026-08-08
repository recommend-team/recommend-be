import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, In, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { Checkout } from './entities/checkout.entity';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { Product } from '../products/entities/product.entity';
import { PaymentsService } from '../payments/payments.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';

/** Platform's cut of every vendor's goods subtotal. */
const PLATFORM_FEE_RATE = 0.2;

export type CartChangeReason =
  | 'REMOVED'
  | 'UNAVAILABLE'
  | 'VENDOR_CLOSED'
  | 'PRICE_CHANGED';

export interface CartChange {
  productId: string;
  productName: string | null;
  reason: CartChangeReason;
  expectedUnitPrice?: number;
  currentUnitPrice?: number;
}

export interface CheckoutResult {
  checkoutId: string;
  reference: string;
  authorizationUrl: string;
  accessCode: string;
  paystackPublicKey: string | null;
  goodsTotal: number;
  deliveryFee: number;
  totalAmount: number;
  vendorCount: number;
}

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    @InjectRepository(Checkout)
    private readonly checkoutsRepository: Repository<Checkout>,
    private readonly paymentsService: PaymentsService,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * What delivery costs, for a checkout not yet placed.
   *
   * Public because the chat reads the order back to the buyer *before* charging, and the
   * figure it quotes must be the figure it charges. One rule, one place — a second copy
   * in the conversation layer would drift the day this becomes per-vendor or distance-based.
   */
  deliveryFeeFor(fulfillmentType: FulfillmentType): number {
    return fulfillmentType === FulfillmentType.DELIVERY
      ? round2(this.configService.get<number>('delivery.feeNgn') ?? 0)
      : 0;
  }

  /**
   * Turn a client-held cart into one charge and one order per vendor.
   *
   * The cart lives in the browser's localStorage, so everything in it is untrusted.
   * Prices, availability and vendor status are all re-read from the database here —
   * otherwise a buyer could post themselves a ₦100 order.
   */
  async createCheckout(dto: CreateCheckoutDto): Promise<CheckoutResult> {
    const products = await this.loadProducts(dto);
    const changes = this.detectChanges(dto, products);

    if (changes.length > 0) {
      // 409 rather than a silent adjustment: the buyer agreed to a basket, and a
      // different one must be shown to them before they pay for it.
      throw new ConflictException({
        code: 'CART_CHANGED',
        message: 'Some items changed since you added them.',
        changes,
      });
    }

    const grouped = this.groupByVendor(dto, products);
    const goodsTotal = round2(
      [...grouped.values()].reduce((sum, group) => sum + group.subtotal, 0),
    );

    // Snapshotted onto the row below — never re-read for an existing order.
    const deliveryFee = this.deliveryFeeFor(dto.fulfillmentType);

    const totalAmount = round2(goodsTotal + deliveryFee);
    const reference = `REC-${randomBytes(6).toString('hex').toUpperCase()}`;

    const checkout = await this.persist(dto, grouped, {
      reference,
      goodsTotal,
      deliveryFee,
      totalAmount,
    });

    let authorizationUrl: string;
    let accessCode: string;
    try {
      const payment = await this.paymentsService.initializePayment({
        email: dto.buyerEmail ?? syntheticEmail(dto.buyerPhone),
        amountNgn: totalAmount,
        reference,
        metadata: {
          checkoutId: checkout.id,
          buyerName: dto.buyerName,
          buyerPhone: dto.buyerPhone,
          vendorCount: grouped.size,
        },
      });
      authorizationUrl = payment.authorizationUrl;
      accessCode = payment.accessCode;
    } catch (error) {
      await this.checkoutsRepository.delete({ id: checkout.id });
      this.logger.error(
        `Rolled back checkout ${checkout.id} — payment init failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      throw error;
    }

    this.logger.log(
      `Checkout ${checkout.id} created — ${grouped.size} vendor(s), total ${totalAmount} (ref=${reference})`,
    );

    return {
      checkoutId: checkout.id,
      reference,
      authorizationUrl,
      accessCode,
      paystackPublicKey:
        this.configService.get<string>('payment.paystackPublicKey') ?? null,
      goodsTotal,
      deliveryFee,
      totalAmount,
      vendorCount: grouped.size,
    };
  }

  // ─── Validation ─────────────────────────────────────────────────────────────

  private async loadProducts(
    dto: CreateCheckoutDto,
  ): Promise<Map<string, Product>> {
    const ids = [...new Set(dto.items.map((item) => item.productId))];

    const products = await this.productsRepository.find({
      where: { id: In(ids) },
      relations: ['vendor'],
    });

    return new Map(products.map((product) => [product.id, product]));
  }

  /** Everything about the cart that no longer matches reality. */
  private detectChanges(
    dto: CreateCheckoutDto,
    products: Map<string, Product>,
  ): CartChange[] {
    const changes: CartChange[] = [];

    for (const line of dto.items) {
      const product = products.get(line.productId);

      if (!product) {
        changes.push({
          productId: line.productId,
          productName: null,
          reason: 'REMOVED',
        });
        continue;
      }

      if (
        !product.isAvailable ||
        product.vendor?.status !== SellerStatus.APPROVED
      ) {
        changes.push({
          productId: line.productId,
          productName: product.name,
          reason: 'UNAVAILABLE',
        });
        continue;
      }

      if (!product.vendor.isOpen) {
        changes.push({
          productId: line.productId,
          productName: product.name,
          reason: 'VENDOR_CLOSED',
        });
        continue;
      }

      const currentUnitPrice = round2(Number(product.price));
      if (
        line.expectedUnitPrice !== undefined &&
        round2(line.expectedUnitPrice) !== currentUnitPrice
      ) {
        changes.push({
          productId: line.productId,
          productName: product.name,
          reason: 'PRICE_CHANGED',
          expectedUnitPrice: round2(line.expectedUnitPrice),
          currentUnitPrice,
        });
      }
    }

    return changes;
  }

  // ─── Grouping and money ─────────────────────────────────────────────────────

  private groupByVendor(
    dto: CreateCheckoutDto,
    products: Map<string, Product>,
  ): Map<string, VendorGroup> {
    const grouped = new Map<string, VendorGroup>();

    for (const line of dto.items) {
      const product = products.get(line.productId);
      if (!product) continue; // unreachable — detectChanges would have thrown

      const unitPrice = round2(Number(product.price));
      const lineTotal = round2(unitPrice * line.quantity);

      const group = grouped.get(product.vendorId) ?? {
        vendorId: product.vendorId,
        subtotal: 0,
        items: [],
      };

      // The same product twice in one cart is one line with the summed quantity.
      const existing = group.items.find(
        (item) => item.productId === product.id,
      );
      if (existing) {
        existing.quantity += line.quantity;
        existing.lineTotal = round2(existing.unitPrice * existing.quantity);
      } else {
        group.items.push({
          productId: product.id,
          productName: product.name,
          unitPrice,
          quantity: line.quantity,
          lineTotal,
        });
      }

      group.subtotal = round2(
        group.items.reduce((sum, item) => sum + item.lineTotal, 0),
      );
      grouped.set(product.vendorId, group);
    }

    if (grouped.size === 0) {
      throw new BadRequestException('Your cart is empty');
    }

    return grouped;
  }

  private async persist(
    dto: CreateCheckoutDto,
    grouped: Map<string, VendorGroup>,
    totals: {
      reference: string;
      goodsTotal: number;
      deliveryFee: number;
      totalAmount: number;
    },
  ): Promise<Checkout> {
    return this.dataSource.transaction(async (manager) => {
      const checkout = manager.create(Checkout, {
        reference: totals.reference,
        buyerId: null,
        buyerName: dto.buyerName,
        buyerPhone: dto.buyerPhone,
        buyerEmail: dto.buyerEmail ?? null,
        fulfillmentType: dto.fulfillmentType,
        deliveryAddress: dto.deliveryAddress ?? null,
        notes: dto.notes ?? null,
        goodsTotal: totals.goodsTotal,
        deliveryFee: totals.deliveryFee,
        totalAmount: totals.totalAmount,
        status: OrderStatus.PENDING_PAYMENT,
        paidAt: null,
      });
      const savedCheckout = await manager.save(checkout);

      for (const group of grouped.values()) {
        // Each vendor is owed 80% of THEIR items. Delivery never enters this.
        const platformFee = round2(group.subtotal * PLATFORM_FEE_RATE);
        const vendorAmount = round2(group.subtotal - platformFee);

        const order = manager.create(Order, {
          checkoutId: savedCheckout.id,
          vendorId: group.vendorId,
          buyerName: dto.buyerName,
          buyerPhone: dto.buyerPhone,
          buyerEmail: dto.buyerEmail ?? null,
          totalAmount: group.subtotal,
          platformFee,
          vendorAmount,
          fulfillmentType: dto.fulfillmentType,
          status: OrderStatus.PENDING_PAYMENT,
          deliveryAddress: dto.deliveryAddress ?? null,
          notes: dto.notes ?? null,
          paidAt: null,
        });
        const savedOrder = await manager.save(order);

        await manager.save(
          group.items.map((item) =>
            manager.create(OrderItem, { ...item, orderId: savedOrder.id }),
          ),
        );
      }

      return savedCheckout;
    });
  }
}

interface VendorGroup {
  vendorId: string;
  subtotal: number;
  items: {
    productId: string;
    productName: string;
    unitPrice: number;
    quantity: number;
    lineTotal: number;
  }[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Paystack requires an email; buyers who gave only a phone get a non-routable one. */
function syntheticEmail(phoneE164: string): string {
  return `${phoneE164.replace('+', '')}@buyers.recommend.ng`;
}
