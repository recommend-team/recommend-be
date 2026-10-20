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
import { OrderItem, OrderItemChoice } from './entities/order-item.entity';
import { ProductChoiceGroup } from '../products/entities/product-choice.entity';
import { Product } from '../products/entities/product.entity';
import { PaymentsService } from '../payments/payments.service';
import {
  CheckoutLineDto,
  CreateCheckoutDto,
  isPackLine,
} from './dto/create-checkout.dto';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';
import { CheckoutSource } from '../../common/enums/checkout-source.enum';
import { toOrderLines } from './order-lines';
import { openingStatus } from '../../common/utils/opening-hours.util';

const FALLBACK_PLATFORM_FEE_RATE = 0.2;

export type CartChangeReason =
  | 'REMOVED'
  | 'UNAVAILABLE'
  /** Paused, or outside opening hours — `opensAt` says when to come back, if known. */
  | 'VENDOR_CLOSED'
  | 'PRICE_CHANGED'
  /** An add-on with no main item from its vendor in the cart — never sold alone. */
  | 'ADDON_WITHOUT_MAIN'
  /** An extra no longer ticked on the dish it was added to. */
  | 'EXTRA_NOT_OFFERED'
  /** A required choice unanswered (perhaps added since), or too many / too few picked. */
  | 'CHOICES_NEEDED'
  /** A chosen option removed or marked unavailable since. */
  | 'CHOICE_UNAVAILABLE';

export interface CartChange {
  productId: string;
  productName: string | null;
  reason: CartChangeReason;
  expectedUnitPrice?: number;
  currentUnitPrice?: number;
  /** On an extra: the dish it was added to. */
  dishId?: string;
  dishName?: string;
  /** On a choice problem: which choice, and which option. */
  groupId?: string;
  groupName?: string;
  optionId?: string;
  optionName?: string | null;
  /** On a closed vendor: when they next open (ISO), null if paused or no hours open. */
  opensAt?: string | null;
}

/** A cart priced, not placed — see `CheckoutService.quote`. */
export interface CartQuote {
  lines: {
    name: string;
    vendorName: string | null;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }[];
  goodsTotal: number;
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
    @InjectRepository(ProductChoiceGroup)
    private readonly choiceGroupsRepository: Repository<ProductChoiceGroup>,
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
   * Whether buyers may collect orders themselves — `PICKUP_ENABLED`. Read per call, like
   * the fee, so the chat and checkout always agree.
   */
  pickupEnabled(): boolean {
    return this.configService.get<boolean>('delivery.pickupEnabled') ?? false;
  }

  /**
   * Recommend's cut of a vendor's subtotal, as a fraction.
   *
   * Read per checkout rather than cached on the instance, so a rate change takes effect on
   * the next order instead of the next deploy. Orders already placed are untouched: their
   * fee and payout were written onto the row when they were created, and nothing recomputes
   * them afterwards.
   */
  private platformFeeRate(): number {
    return (
      this.configService.get<number>('platform.feeRate') ??
      FALLBACK_PLATFORM_FEE_RATE
    );
  }

  /**
   * Turn a client-held cart into one charge and one order per vendor.
   *
   * The cart lives in the browser's localStorage, so everything in it is untrusted.
   * Prices, availability and vendor status are all re-read from the database here —
   * otherwise a buyer could post themselves a ₦100 order.
   */
  async createCheckout(
    dto: CreateCheckoutDto,
    createdByAdminId: string | null = null,
    /** Where it is placed. Omitted: by an admin if `createdByAdminId` is set, else the chat. */
    source: CheckoutSource = createdByAdminId
      ? CheckoutSource.ADMIN
      : CheckoutSource.CHAT,
  ): Promise<CheckoutResult> {
    const storefront = source === CheckoutSource.STOREFRONT;

    // A storefront buyer may never open the chat; email is how the receipt and the
    // delivery code reach them, and how their order finds its way into the chat.
    if (storefront && !dto.buyerEmail) {
      throw new BadRequestException({
        code: 'EMAIL_REQUIRED',
        message:
          'Please give an email — your receipt and delivery code go there.',
      });
    }
    if (
      storefront &&
      dto.fulfillmentType === FulfillmentType.DELIVERY &&
      !dto.areaId
    ) {
      throw new BadRequestException({
        code: 'AREA_REQUIRED',
        message: 'Please choose the area we are delivering to.',
      });
    }

    // Enforced here, where every checkout passes — chat, website and admin alike — so
    // no client can place a pickup order while pickup is switched off.
    if (
      dto.fulfillmentType === FulfillmentType.PICKUP &&
      !this.pickupEnabled()
    ) {
      throw new BadRequestException({
        code: 'PICKUP_UNAVAILABLE',
        message: 'Pickup is not available yet — please choose delivery.',
      });
    }

    const menu = await this.loadMenu(dto);
    const { products } = menu;
    const changes = this.detectChanges(dto, menu);

    if (changes.length > 0) {
      // 409 rather than a silent adjustment: the buyer agreed to a basket, and a
      // different one must be shown to them before they pay for it.
      throw new ConflictException({
        code: 'CART_CHANGED',
        message: 'Some items changed since you added them.',
        changes,
      });
    }

    const grouped = this.groupByVendor(dto, menu);

    // Refused before payment, not discovered after it: the vendor must deliver there.
    if (dto.areaId && dto.fulfillmentType === FulfillmentType.DELIVERY) {
      await this.assertDeliversTo(dto.areaId, grouped, products);
    }

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
      createdByAdminId,
      source,
    });

    // A storefront buyer paying on Paystack's own page comes back to their order on the
    // website. The chat pays in a popup and never leaves, so it needs no return address.
    const websiteUrl = this.configService.get<string>('app.websiteUrl');
    const callbackUrl =
      storefront && websiteUrl
        ? `${websiteUrl}/order/${encodeURIComponent(reference)}`
        : undefined;

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
          source,
        },
        callbackUrl,
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

  /**
   * What a cart would cost, priced exactly as \`createCheckout\` would price it — packs,
   * choices, extras — without placing anything. The chat reads this back to the buyer
   * before asking them to pay, so the figure quoted is the figure charged.
   *
   * Throws the same CART_CHANGED conflict when the cart no longer matches the menu.
   */
  async quote(items: CreateCheckoutDto['items']): Promise<CartQuote> {
    const dto = { items } as CreateCheckoutDto;
    const menu = await this.loadMenu(dto);
    const changes = this.detectChanges(dto, menu);
    if (changes.length > 0) {
      throw new ConflictException({
        code: 'CART_CHANGED',
        message: 'Some items changed since you added them.',
        changes,
      });
    }
    const grouped = this.groupByVendor(dto, menu);

    const lines: CartQuote['lines'] = [];
    for (const group of grouped.values()) {
      const vendorName =
        [...menu.products.values()].find((p) => p.vendorId === group.vendorId)
          ?.vendor?.businessName ?? null;
      // Read back the way receipts read: one line per dish, packs and extras folded in.
      let n = 0;
      const rows = group.dishes.flatMap((dish) => {
        const id = `quote-${n++}`;
        return [
          { ...dish, id, parentItemId: null, choices: dish.choices },
          ...dish.extras.map((extra) => ({
            ...extra,
            id: `quote-${n++}`,
            parentItemId: id,
            choices: [],
          })),
        ];
      }) as unknown as OrderItem[];
      for (const line of toOrderLines(rows)) {
        lines.push({
          name: line.name,
          vendorName,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
        });
      }
    }

    return {
      lines,
      goodsTotal: round2(
        [...grouped.values()].reduce((sum, group) => sum + group.subtotal, 0),
      ),
    };
  }

  // ─── Validation ─────────────────────────────────────────────────────────────

  /**
   * Everything the cart mentions — dishes and their extras — with each dish's choices and
   * the extras ticked on it, read in three queries.
   */
  private async loadMenu(dto: CreateCheckoutDto): Promise<Menu> {
    const ids = [
      ...new Set(
        dto.items.flatMap((item) => [
          item.productId,
          ...(item.extras ?? []).map((extra) => extra.productId),
        ]),
      ),
    ];

    const [products, groups, links] = await Promise.all([
      this.productsRepository.find({
        where: { id: In(ids) },
        relations: ['vendor'],
      }),
      this.choiceGroupsRepository.find({
        where: { productId: In(ids) },
        relations: ['options'],
      }),
      this.dataSource.query<{ productId: string; extraId: string }[]>(
        `SELECT "productId", "extraId" FROM product_extras WHERE "productId" = ANY($1::uuid[])`,
        [ids],
      ),
    ]);

    const choices = new Map<string, ProductChoiceGroup[]>();
    for (const group of groups) {
      choices.set(group.productId, [
        ...(choices.get(group.productId) ?? []),
        group,
      ]);
    }
    const extrasOn = new Map<string, Set<string>>();
    for (const link of links) {
      const set = extrasOn.get(link.productId) ?? new Set<string>();
      set.add(link.extraId);
      extrasOn.set(link.productId, set);
    }

    return {
      products: new Map(products.map((product) => [product.id, product])),
      choices,
      extrasOn,
    };
  }

  /** Everything about the cart that no longer matches reality. */
  private detectChanges(dto: CreateCheckoutDto, menu: Menu): CartChange[] {
    const changes: CartChange[] = [];
    const { products } = menu;
    // One moment for the whole cart, so two lines cannot disagree about closing time.
    const now = new Date();

    for (const line of dto.items) {
      const product = products.get(line.productId);
      const dishProblem = this.problemWith(line.productId, product, line, now);
      if (dishProblem) {
        changes.push(dishProblem);
        continue;
      }
      const dish = product!;

      if (isPackLine(line) && dish.isAddOn) {
        throw new BadRequestException(
          `${dish.name} is an extra — add it to a dish rather than on its own.`,
        );
      }

      // Its extras: each must still be ticked on this dish, on sale, at the price shown.
      const offered = menu.extrasOn.get(dish.id) ?? new Set<string>();
      for (const extraLine of line.extras ?? []) {
        const extra = products.get(extraLine.productId);
        const problem = this.problemWith(
          extraLine.productId,
          extra,
          extraLine,
          now,
        );
        if (problem) {
          changes.push({ ...problem, dishId: dish.id, dishName: dish.name });
          continue;
        }
        if (!extra!.isAddOn || !offered.has(extra!.id)) {
          changes.push({
            productId: extra!.id,
            productName: extra!.name,
            reason: 'EXTRA_NOT_OFFERED',
            dishId: dish.id,
            dishName: dish.name,
          });
        }
      }

      changes.push(...this.choiceProblems(dish, line, menu));
    }

    // An add-on rides with a meal from its own kitchen: one vendor cooks, packs and
    // delivers both, and is paid for both. Without a main item from that vendor it is
    // refused — the client hides this case, but the server is where it is enforced.
    const vendorsWithMain = new Set(
      dto.items
        .map((line) => products.get(line.productId))
        .filter((product): product is Product => !!product && !product.isAddOn)
        .map((product) => product.vendorId),
    );
    for (const line of dto.items) {
      const product = products.get(line.productId);
      if (product?.isAddOn && !vendorsWithMain.has(product.vendorId)) {
        changes.push({
          productId: line.productId,
          productName: product.name,
          reason: 'ADDON_WITHOUT_MAIN',
        });
      }
    }

    return changes;
  }

  /** Gone, off sale, closed, or re-priced since the buyer saw it — or nothing wrong. */
  private problemWith(
    productId: string,
    product: Product | undefined,
    line: { expectedUnitPrice?: number },
    now: Date,
  ): CartChange | null {
    if (!product) {
      return { productId, productName: null, reason: 'REMOVED' };
    }
    if (
      !product.isAvailable ||
      product.vendor?.status !== SellerStatus.APPROVED
    ) {
      return { productId, productName: product.name, reason: 'UNAVAILABLE' };
    }
    const hours = openingStatus(product.vendor, now);
    if (!hours.openNow) {
      return {
        productId,
        productName: product.name,
        reason: 'VENDOR_CLOSED',
        opensAt: hours.opensAt?.toISOString() ?? null,
      };
    }
    const currentUnitPrice = round2(Number(product.price));
    if (
      line.expectedUnitPrice !== undefined &&
      round2(line.expectedUnitPrice) !== currentUnitPrice
    ) {
      return {
        productId,
        productName: product.name,
        reason: 'PRICE_CHANGED',
        expectedUnitPrice: round2(line.expectedUnitPrice),
        currentUnitPrice,
      };
    }
    return null;
  }

  /**
   * The dish's choices as answered: every required one answered, each within how many
   * may be picked, every option still on the menu and available.
   */
  private choiceProblems(
    dish: Product,
    line: CheckoutLineDto,
    menu: Menu,
  ): CartChange[] {
    const groups = menu.choices.get(dish.id) ?? [];
    const answers = line.choices ?? [];
    const changes: CartChange[] = [];
    const base = { productId: dish.id, productName: dish.name };

    const seen = new Set<string>();
    for (const answer of answers) {
      if (seen.has(answer.groupId)) {
        throw new BadRequestException(
          `${dish.name}: one choice answered twice.`,
        );
      }
      seen.add(answer.groupId);

      const group = groups.find((g) => g.id === answer.groupId);
      if (!group) {
        changes.push({ ...base, reason: 'CHOICE_UNAVAILABLE' });
        continue;
      }
      const optionIds = [...new Set(answer.optionIds)];
      for (const optionId of optionIds) {
        const option = group.options.find((o) => o.id === optionId);
        if (!option || !option.isAvailable) {
          changes.push({
            ...base,
            reason: 'CHOICE_UNAVAILABLE',
            groupId: group.id,
            groupName: group.name,
            optionId,
            optionName: option?.name ?? null,
          });
        }
      }
      if (
        optionIds.length < group.minPick ||
        optionIds.length > group.maxPick
      ) {
        changes.push({
          ...base,
          reason: 'CHOICES_NEEDED',
          groupId: group.id,
          groupName: group.name,
        });
      }
    }

    // A required choice the buyer never saw — added since, or an older app.
    for (const group of groups) {
      if (group.minPick > 0 && !seen.has(group.id)) {
        changes.push({
          ...base,
          reason: 'CHOICES_NEEDED',
          groupId: group.id,
          groupName: group.name,
        });
      }
    }

    return changes;
  }

  /**
   * Every vendor in the basket must deliver to the buyer's area. Refused with the
   * vendors that do not, so the buyer can be told by name.
   */
  private async assertDeliversTo(
    areaId: string,
    grouped: Map<string, VendorGroup>,
    products: Map<string, Product>,
  ): Promise<void> {
    const vendorIds = [...grouped.keys()];
    const rows: { vendorId: string }[] = await this.dataSource.query(
      `SELECT "vendorId" FROM vendor_service_areas
        WHERE "areaId" = $1 AND "vendorId" = ANY($2::uuid[])`,
      [areaId, vendorIds],
    );
    const serving = new Set(rows.map((row) => row.vendorId));

    const notServing = vendorIds.filter((id) => !serving.has(id));
    if (notServing.length === 0) return;

    const names = notServing.map(
      (id) =>
        [...products.values()].find((product) => product.vendorId === id)
          ?.vendor?.businessName ?? 'This vendor',
    );
    throw new BadRequestException({
      code: 'AREA_NOT_SERVED',
      message: `${names.join(' and ')} ${
        names.length === 1 ? "doesn't" : "don't"
      } deliver to that area. Please choose one of their delivery areas.`,
      vendors: notServing,
    });
  }

  // ─── Grouping and money ─────────────────────────────────────────────────────

  /**
   * One order per vendor, each a list of dishes with their extras and choices.
   *
   * A pack is priced (portions × (price + choice costs) + Σ extras) × packs, all from the
   * database. A line from an older client is a plain line; its extras arrive as lines of
   * their own and are attached to the vendor's first dish, priced as before.
   */
  private groupByVendor(
    dto: CreateCheckoutDto,
    menu: Menu,
  ): Map<string, VendorGroup> {
    const grouped = new Map<string, VendorGroup>();
    const looseExtras: { product: Product; quantity: number }[] = [];
    const groupFor = (vendorId: string): VendorGroup => {
      const group = grouped.get(vendorId) ?? {
        vendorId,
        subtotal: 0,
        dishes: [],
      };
      grouped.set(vendorId, group);
      return group;
    };

    for (const line of dto.items) {
      const product = menu.products.get(line.productId);
      if (!product) continue; // unreachable — detectChanges would have thrown

      if (product.isAddOn) {
        looseExtras.push({ product, quantity: line.quantity });
        continue;
      }

      const group = groupFor(product.vendorId);
      const pack = isPackLine(line);
      const packs = line.packs ?? 1;

      const chosen = this.chosenOptions(product, line, menu);
      const unitPrice = round2(
        Number(product.price) +
          chosen.reduce((sum, choice) => sum + choice.priceDelta, 0),
      );

      // An older client's plain line for the same product twice is one line, as before.
      const existing = !pack
        ? group.dishes.find(
            (dish) => !dish.pack && dish.productId === product.id,
          )
        : undefined;
      if (existing) {
        existing.quantity += line.quantity;
        existing.lineTotal = round2(existing.unitPrice * existing.quantity);
        continue;
      }

      group.dishes.push({
        productId: product.id,
        productName: product.name,
        unit: product.unit ?? null,
        unitPrice,
        quantity: line.quantity,
        packs,
        lineTotal: round2(unitPrice * line.quantity * packs),
        isAddOn: false,
        pack,
        choices: chosen,
        extras: (line.extras ?? []).map((extraLine) => {
          const extra = menu.products.get(extraLine.productId)!;
          const price = round2(Number(extra.price));
          return {
            productId: extra.id,
            productName: extra.name,
            unit: extra.unit ?? null,
            unitPrice: price,
            quantity: extraLine.quantity,
            packs,
            lineTotal: round2(price * extraLine.quantity * packs),
            isAddOn: true,
          };
        }),
      });
    }

    // Older clients' extras go with a dish of that vendor's that offers them — its first
    // dish if none does (detectChanges has already refused any extra with no dish from
    // its vendor).
    for (const { product, quantity } of looseExtras) {
      const dishes = grouped.get(product.vendorId)?.dishes ?? [];
      const dish =
        dishes.find((d) => menu.extrasOn.get(d.productId)?.has(product.id)) ??
        dishes[0];
      if (!dish) continue;
      const price = round2(Number(product.price));
      const same = dish.extras.find(
        (extra) => extra.productId === product.id && extra.packs === 1,
      );
      if (same) {
        same.quantity += quantity;
        same.lineTotal = round2(same.unitPrice * same.quantity);
      } else {
        dish.extras.push({
          productId: product.id,
          productName: product.name,
          unit: product.unit ?? null,
          unitPrice: price,
          quantity,
          packs: 1,
          lineTotal: round2(price * quantity),
          isAddOn: true,
        });
      }
    }

    for (const group of grouped.values()) {
      group.subtotal = round2(
        group.dishes.reduce(
          (sum, dish) =>
            sum +
            dish.lineTotal +
            dish.extras.reduce((inner, extra) => inner + extra.lineTotal, 0),
          0,
        ),
      );
    }

    if (grouped.size === 0) {
      throw new BadRequestException('Your cart is empty');
    }

    return grouped;
  }

  /** The options picked on a dish, copied with their cost for the order. */
  private chosenOptions(
    product: Product,
    line: CheckoutLineDto,
    menu: Menu,
  ): ChosenOption[] {
    const groups = menu.choices.get(product.id) ?? [];
    const chosen: ChosenOption[] = [];
    for (const answer of line.choices ?? []) {
      const group = groups.find((g) => g.id === answer.groupId);
      if (!group) continue; // detectChanges refused it
      for (const optionId of new Set(answer.optionIds)) {
        const option = group.options.find((o) => o.id === optionId);
        if (!option) continue;
        chosen.push({
          groupName: group.name,
          optionName: option.name,
          priceDelta: round2(Number(option.priceDelta)),
          groupPosition: group.position,
          optionPosition: option.position,
        });
      }
    }
    return chosen.sort(
      (a, b) =>
        a.groupPosition - b.groupPosition ||
        a.optionPosition - b.optionPosition,
    );
  }

  private async persist(
    dto: CreateCheckoutDto,
    grouped: Map<string, VendorGroup>,
    totals: {
      reference: string;
      goodsTotal: number;
      deliveryFee: number;
      totalAmount: number;
      createdByAdminId: string | null;
      source: CheckoutSource;
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
        // Written here, in the transaction that creates the row. A second UPDATE
        // afterwards would leave a window in which an admin-created order is
        // attributed to nobody.
        createdByAdminId: totals.createdByAdminId,
        source: totals.source,
      });
      const savedCheckout = await manager.save(checkout);

      const feeRate = this.platformFeeRate();

      for (const group of grouped.values()) {
        // Each vendor is owed their items less the platform's cut. Delivery never enters
        // this. Both figures are written onto the row here and never recomputed.
        const platformFee = round2(group.subtotal * feeRate);
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

        // Each dish, then its extras pointing back at it, so the pack stays whole.
        for (const dish of group.dishes) {
          const savedDish = await manager.save(
            manager.create(OrderItem, {
              orderId: savedOrder.id,
              productId: dish.productId,
              productName: dish.productName,
              unit: dish.unit,
              unitPrice: dish.unitPrice,
              quantity: dish.quantity,
              packs: dish.packs,
              lineTotal: dish.lineTotal,
              isAddOn: false,
              parentItemId: null,
              choices: dish.choices.map((choice) =>
                manager.create(OrderItemChoice, {
                  groupName: choice.groupName,
                  optionName: choice.optionName,
                  priceDelta: choice.priceDelta,
                }),
              ),
            }),
          );
          if (dish.extras.length > 0) {
            await manager.save(
              dish.extras.map((extra) =>
                manager.create(OrderItem, {
                  ...extra,
                  orderId: savedOrder.id,
                  parentItemId: savedDish.id,
                }),
              ),
            );
          }
        }
      }

      return savedCheckout;
    });
  }
}

/** The cart's products, each dish's choices, and the extras ticked on each dish. */
interface Menu {
  products: Map<string, Product>;
  choices: Map<string, ProductChoiceGroup[]>;
  extrasOn: Map<string, Set<string>>;
}

interface ChosenOption {
  groupName: string;
  optionName: string;
  /** Per portion. */
  priceDelta: number;
  groupPosition: number;
  optionPosition: number;
}

interface PricedLine {
  productId: string;
  productName: string;
  unit: string | null;
  /** On a dish: price per portion including choice costs. */
  unitPrice: number;
  /** Per pack. */
  quantity: number;
  packs: number;
  lineTotal: number;
  isAddOn: boolean;
}

interface VendorGroup {
  vendorId: string;
  subtotal: number;
  dishes: (PricedLine & {
    /** Built as a pack rather than an older client's plain line. */
    pack: boolean;
    choices: ChosenOption[];
    extras: PricedLine[];
  })[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Paystack requires an email; buyers who gave only a phone get a non-routable one. */
function syntheticEmail(phoneE164: string): string {
  return `${phoneE164.replace('+', '')}@buyers.recommend.ng`;
}
