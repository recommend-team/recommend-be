import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, ILike } from 'typeorm';
import { User } from '../auth/entities/auth.entity';
import { Product } from '../products/entities/product.entity';
import { Order } from '../orders/entities/order.entity';
import { Checkout } from '../orders/entities/checkout.entity';
import { OrdersService } from '../orders/orders.service';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import {
  OrderStatusEvent,
  StatusActor,
} from '../orders/entities/order-status-event.entity';
import { SellerStatus } from '../../common/enums/seller-status.enum';
import { Role } from '../../common/enums/roles.enum';
import {
  OrderStatus,
  SOLD_ORDER_STATUSES,
} from '../../common/enums/order-status.enum';
import {
  LagosPeriods,
  lagosPeriodStarts,
} from '../../common/utils/lagos-periods';
import { EmailService } from '../../common/services/email.service';
import { CreateAdminDto } from './dto/create-admin.dto';
import type { CreateRiderDto } from './dto/rider.dto';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';
import { RiderType } from '../../common/enums/rider-type.enum';
import { Account, AccountStatus } from '../wallet/entities/account.entity';
import { Withdrawal } from '../wallet/entities/withdrawal.entity';
import { WalletService } from '../wallet/wallet.service';
import { CheckoutSource } from '../../common/enums/checkout-source.enum';
import { DISPATCHED_AT_SQL } from '../orders/stuck-delivery.service';
import { toOrderLines, type OrderLine } from '../orders/order-lines';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** One payment, with the vendor orders it paid for. */
export interface TransactionSummary {
  id: string;
  reference: string;
  status: OrderStatus;
  buyerName: string;
  buyerPhone: string;
  buyerEmail: string | null;
  fulfillmentType: string;
  deliveryAddress: string | null;
  goodsTotal: number;
  deliveryFee: number;
  totalAmount: number;
  paidAt: string | null;
  createdAt: string;
  deliveryCode: string | null;
  createdByAdminId: string | null;
  /** Who is carrying it. Null on a pickup, and on a delivery with no rider yet. */
  rider: { id: string; name: string; phone: string | null } | null;
  riderAssignedAt: string | null;
  /** Where it was placed: the chat, a vendor's storefront, or by an admin. */
  source: CheckoutSource;
  /**
   * Whether the buyer can be reached in the chat. A chat order always can; a storefront
   * buyer only once they have signed in with the email they paid with — until then,
   * follow-up means a phone call.
   */
  buyerOnChat: boolean;
  /** When it last left with a rider. Null until dispatched. */
  dispatchedAt: string | null;
  /** With its rider for longer than `DELIVERY_STALE_HOURS`, and not delivered. */
  stuck: boolean;
  vendors: {
    orderId: string;
    vendorId: string;
    vendorName: string | null;
    status: OrderStatus;
    subtotal: number;
    vendorAmount: number;
    items: { name: string; quantity: number; lineTotal: number }[];
  }[];
}

/** What a transaction row needs beyond the checkout itself — see `followUpFacts`. */
interface FollowUpFacts {
  buyerOnChat: boolean;
  dispatchedAt: Date | null;
}

function toTransactionSummary(
  checkout: Checkout,
  facts: FollowUpFacts | undefined,
  staleCutoff: Date,
): TransactionSummary {
  const source = checkout.source ?? CheckoutSource.CHAT;
  const dispatchedAt = facts?.dispatchedAt ?? null;
  return {
    id: checkout.id,
    reference: checkout.reference,
    status: checkout.status,
    buyerName: checkout.buyerName,
    buyerPhone: checkout.buyerPhone,
    buyerEmail: checkout.buyerEmail,
    fulfillmentType: checkout.fulfillmentType,
    deliveryAddress: checkout.deliveryAddress,
    // Postgres hands decimals back as strings; the client should not have to know that.
    goodsTotal: Number(checkout.goodsTotal),
    deliveryFee: Number(checkout.deliveryFee),
    totalAmount: Number(checkout.totalAmount),
    paidAt: checkout.paidAt ? checkout.paidAt.toISOString() : null,
    createdAt: checkout.createdAt.toISOString(),
    deliveryCode: checkout.deliveryCode ?? null,
    createdByAdminId: checkout.createdByAdminId ?? null,
    rider: checkout.rider
      ? {
          id: checkout.rider.id,
          name: `${checkout.rider.firstName} ${checkout.rider.lastName}`.trim(),
          phone: checkout.rider.phoneNumber ?? null,
        }
      : null,
    riderAssignedAt: checkout.riderAssignedAt
      ? checkout.riderAssignedAt.toISOString()
      : null,
    source,
    // A chat order, or one an admin placed from a conversation they were holding, came
    // from the chat — the buyer is there whether or not they ever signed in.
    buyerOnChat:
      source !== CheckoutSource.STOREFRONT || (facts?.buyerOnChat ?? false),
    dispatchedAt: dispatchedAt ? dispatchedAt.toISOString() : null,
    stuck:
      checkout.status === OrderStatus.DISPATCHED &&
      !!dispatchedAt &&
      dispatchedAt <= staleCutoff,
    vendors: (checkout.orders ?? []).map((order) => ({
      orderId: order.id,
      vendorId: order.vendorId,
      vendorName: order.vendor?.businessName ?? null,
      status: order.status,
      subtotal: Number(order.totalAmount),
      vendorAmount: Number(order.vendorAmount),
      items: toOrderLines(order.items ?? []).map((line) => ({
        name: line.name,
        quantity: line.quantity,
        lineTotal: line.lineTotal,
        productName: line.productName,
        portions: line.portions,
        packs: line.packs,
        unit: line.unit,
        choices: line.choices,
        extras: line.extras,
      })),
    })),
  };
}

/** Which period the vendor list is ranked by. */
export type VendorOrderSort = 'today' | 'week' | 'month' | 'allTime';

/** How many orders a vendor has sold in each period. */
export interface VendorOrderCounts {
  today: number;
  week: number;
  month: number;
  allTime: number;
}

const NO_ORDERS: VendorOrderCounts = {
  today: 0,
  week: 0,
  month: 0,
  allTime: 0,
};

/** A payout account as the admin sees it — the whole number, no verification internals. */
export interface AdminPayoutAccount {
  id: string;
  bankName: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
  status: AccountStatus;
  isDefault: boolean;
  verifiedAt: Date | null;
  removedAt: Date | null;
  createdAt: Date;
}

const ACCOUNT_ORDER: Record<AccountStatus, number> = {
  [AccountStatus.ACTIVE]: 0,
  [AccountStatus.PENDING_VERIFICATION]: 1,
  [AccountStatus.REMOVED]: 2,
};

function toAdminPayoutAccount(account: Account): AdminPayoutAccount {
  return {
    id: account.id,
    bankName: account.bankName,
    bankCode: account.bankCode,
    accountNumber: account.accountNumber,
    accountName: account.accountName,
    status: account.status,
    isDefault: account.isDefault,
    verifiedAt: account.verifiedAt,
    removedAt: account.removedAt,
    createdAt: account.createdAt,
  };
}

/** A withdrawal on the vendor page. Every vendor's are at GET /admin/withdrawals. */
export interface AdminWithdrawalRow {
  id: string;
  reference: string;
  status: Withdrawal['status'];
  amountRequested: number;
  feeAmount: number;
  amountSent: number;
  failureReason: string | null;
  attempts: number;
  settledAt: Date | null;
  createdAt: Date;
  account: {
    bankName: string;
    accountNumber: string;
    accountName: string;
  } | null;
}

function toAdminWithdrawalRow(
  withdrawal: Withdrawal,
  account: Account | undefined,
): AdminWithdrawalRow {
  return {
    id: withdrawal.id,
    reference: withdrawal.reference,
    status: withdrawal.status,
    // Postgres hands decimals back as strings.
    amountRequested: Number(withdrawal.amountRequested),
    feeAmount: Number(withdrawal.feeAmount),
    amountSent: Number(withdrawal.amountSent),
    failureReason: withdrawal.failureReason,
    attempts: withdrawal.attempts,
    settledAt: withdrawal.settledAt,
    createdAt: withdrawal.createdAt,
    account: account
      ? {
          bankName: account.bankName,
          accountNumber: account.accountNumber,
          accountName: account.accountName,
        }
      : null,
  };
}

/** A rider as the admin panel lists them. */
export interface RiderRow {
  id: string;
  firstName: string;
  lastName: string;
  /** Null when the rider gave none. */
  email: string | null;
  phoneNumber: string | null;
  riderType: RiderType | null;
  riderNote: string | null;
  status: SellerStatus;
  createdAt: Date;
  /** Assigned and not yet delivered: paid, ready, or on its way. */
  activeDeliveries: number;
  completedDeliveries: number;
}

const RIDER_FIELDS: (keyof User)[] = [
  'id',
  'firstName',
  'lastName',
  'email',
  'phoneNumber',
  'riderType',
  'riderNote',
  'status',
  'createdAt',
];

/**
 * Every account needs a unique email; a rider an admin adds may have none. Non-routable,
 * like a chat buyer's (`@buyers.recommend.ng`), and never shown as an address.
 */
const SYNTHETIC_RIDER_EMAIL_DOMAIN = '@riders.recommend.ng';
const syntheticRiderEmail = (phoneE164: string) =>
  `${phoneE164.replace('+', '')}${SYNTHETIC_RIDER_EMAIL_DOMAIN}`;

/** Roles that should never appear in buyer/vendor listings for regular admins */
const ADMIN_ROLES = [Role.ADMIN, Role.SUPER_ADMIN];

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    @InjectRepository(Product)
    private readonly productsRepo: Repository<Product>,
    @InjectRepository(Order)
    private readonly ordersRepo: Repository<Order>,
    @InjectRepository(Checkout)
    private readonly checkoutsRepo: Repository<Checkout>,
    private readonly ordersService: OrdersService,
    private readonly lifecycle: OrderLifecycleService,
    @InjectRepository(OrderStatusEvent)
    private readonly statusEvents: Repository<OrderStatusEvent>,
    private readonly emailService: EmailService,
    @InjectRepository(Account)
    private readonly accountsRepo: Repository<Account>,
    @InjectRepository(Withdrawal)
    private readonly withdrawalsRepo: Repository<Withdrawal>,
    private readonly wallet: WalletService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  // ─── Pending approvals (unified) ───────────────────────────────────────────

  /**
   * Returns vendors + riders that are PENDING approval, sorted by createdAt ASC
   * so oldest requests surface first.
   */
  async getPendingAll(
    page = 1,
    limit = 20,
  ): Promise<PaginatedResult<Partial<User>>> {
    const skip = (page - 1) * limit;

    const [items, total] = await this.usersRepo.findAndCount({
      where: [
        { role: Role.SELLER, status: SellerStatus.PENDING },
        { role: Role.RIDER, status: SellerStatus.PENDING },
      ],
      select: [
        'id',
        'firstName',
        'lastName',
        'email',
        'phoneNumber',
        'role',
        'status',
        'vendorType',
        'riderType',
        'businessName',
        'isEmailVerified',
        'createdAt',
      ],
      skip,
      take: limit,
      order: { createdAt: 'ASC' },
    });

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async approveUser(
    id: string,
  ): Promise<{ message: string; data: Partial<User> }> {
    const user = await this.findUserById(id);

    if (![Role.SELLER, Role.RIDER].includes(user.role)) {
      throw new BadRequestException(
        'Only vendors and riders can be approved via this endpoint',
      );
    }
    if (user.status === SellerStatus.APPROVED) {
      throw new BadRequestException('User is already approved');
    }

    user.status = SellerStatus.APPROVED;
    const saved = await this.usersRepo.save(user);
    await this.sendApprovalEmail(
      saved,
      user.role === Role.SELLER ? 'vendor' : 'rider',
    );

    return {
      message: `${saved.fullName} has been approved`,
      data: this.stripSensitive(saved),
    };
  }

  async rejectUser(
    id: string,
    reason: string,
  ): Promise<{ message: string; data: Partial<User> }> {
    const user = await this.findUserById(id);

    if (![Role.SELLER, Role.RIDER].includes(user.role)) {
      throw new BadRequestException(
        'Only vendors and riders can be rejected via this endpoint',
      );
    }
    if (user.status === SellerStatus.DEACTIVATED) {
      throw new BadRequestException('User is already rejected/deactivated');
    }

    user.status = SellerStatus.DEACTIVATED;
    const saved = await this.usersRepo.save(user);
    await this.sendRejectionEmail(
      saved,
      user.role === Role.SELLER ? 'vendor' : 'rider',
      reason,
    );

    return {
      message: `${saved.fullName} has been rejected`,
      data: this.stripSensitive(saved),
    };
  }

  // ─── Vendors ───────────────────────────────────────────────────────────────

  /**
   * Returns all vendor stores with their product counts and owner details.
   * Available to admins only for store management oversight.
   */
  async getAllStores(query: {
    status?: SellerStatus;
    page?: number;
    limit?: number;
  }): Promise<
    PaginatedResult<{
      id: string;
      firstName: string;
      lastName: string;
      email: string;
      phoneNumber: string | null;
      businessName: string | null;
      businessCategory: string | null;
      businessLogoUrl: string | null;
      slug: string | null;
      vendorType: string | null;
      status: SellerStatus;
      isOpen: boolean;
      isEmailVerified: boolean;
      productCount: number;
      createdAt: Date;
    }>
  > {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { role: Role.SELLER };
    if (query.status) where['status'] = query.status;

    const [vendors, total] = await this.usersRepo.findAndCount({
      where,
      select: [
        'id',
        'firstName',
        'lastName',
        'email',
        'phoneNumber',
        'businessName',
        'businessCategory',
        'businessLogoUrl',
        'slug',
        'vendorType',
        'status',
        'isOpen',
        'isEmailVerified',
        'createdAt',
      ],
      skip,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    // Get product counts for each vendor
    const items = await Promise.all(
      vendors.map(async (vendor) => {
        const productCount = await this.productsRepo.count({
          where: { vendorId: vendor.id },
        });

        return {
          id: vendor.id,
          firstName: vendor.firstName,
          lastName: vendor.lastName,
          email: vendor.email,
          phoneNumber: vendor.phoneNumber,
          businessName: vendor.businessName,
          businessCategory: vendor.businessCategory,
          businessLogoUrl: vendor.businessLogoUrl,
          slug: vendor.slug,
          vendorType: vendor.vendorType,
          status: vendor.status,
          isOpen: vendor.isOpen,
          isEmailVerified: vendor.isEmailVerified,
          productCount,
          createdAt: vendor.createdAt,
        };
      }),
    );

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Every vendor, with how many orders they have sold today, this week, this month and
   * ever — sortable by any of the four, across all vendors, not just the page shown.
   *
   * An order is one vendor's share of a purchase, counted once paid and not called off,
   * at the moment it was paid. Periods are Lagos calendar periods (weeks from Monday).
   */
  async getVendors(query: {
    status?: SellerStatus;
    page?: number;
    limit?: number;
    sort?: VendorOrderSort;
  }): Promise<PaginatedResult<Partial<User> & { orders: VendorOrderCounts }>> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;
    const periods = lagosPeriodStarts();

    const qb = this.usersRepo
      .createQueryBuilder('vendor')
      .select(
        [
          'id',
          'firstName',
          'lastName',
          'email',
          'phoneNumber',
          'role',
          'status',
          'vendorType',
          'businessName',
          'businessAddress',
          'businessCategory',
          'businessLogoUrl',
          'slug',
          'isOpen',
          'isEmailVerified',
          'createdAt',
        ].map((field) => `vendor.${field}`),
      )
      .where('vendor.role = :role', { role: Role.SELLER })
      .skip(skip)
      .take(limit);

    if (query.status) {
      qb.andWhere('vendor.status = :status', { status: query.status });
    }

    if (query.sort) {
      // Ranked across every vendor, so "top this week" is the real top, not page one's.
      const since = query.sort === 'allTime' ? null : periods[query.sort];
      qb.orderBy(
        `(SELECT COUNT(*) FROM orders o
           WHERE o."vendorId" = vendor.id
             AND o.status IN (:...sold)
             AND o."paidAt" IS NOT NULL
             ${since ? 'AND o."paidAt" >= :since' : ''})`,
        'DESC',
      )
        .setParameter('sold', SOLD_ORDER_STATUSES)
        .setParameter('since', since)
        .addOrderBy('vendor.createdAt', 'DESC');
    } else {
      qb.orderBy('vendor.createdAt', 'DESC');
    }

    const [vendors, total] = await qb.getManyAndCount();
    const counts = await this.vendorOrderCounts(
      vendors.map((vendor) => vendor.id),
      periods,
    );

    const items = vendors.map((vendor) => ({
      ...vendor,
      orders: counts.get(vendor.id) ?? NO_ORDERS,
    }));

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /** The four counts for a page of vendors, in one query. */
  private async vendorOrderCounts(
    vendorIds: string[],
    periods: LagosPeriods,
  ): Promise<Map<string, VendorOrderCounts>> {
    if (vendorIds.length === 0) return new Map();

    const rows = await this.ordersRepo
      .createQueryBuilder('o')
      .select('o.vendorId', 'vendorId')
      .addSelect('COUNT(*) FILTER (WHERE o.paidAt >= :today)', 'today')
      .addSelect('COUNT(*) FILTER (WHERE o.paidAt >= :week)', 'week')
      .addSelect('COUNT(*) FILTER (WHERE o.paidAt >= :month)', 'month')
      .addSelect('COUNT(*)', 'allTime')
      .where('o.vendorId IN (:...vendorIds)', { vendorIds })
      .andWhere('o.status IN (:...sold)', { sold: SOLD_ORDER_STATUSES })
      .andWhere('o.paidAt IS NOT NULL')
      .setParameters(periods)
      .groupBy('o.vendorId')
      .getRawMany<{
        vendorId: string;
        today: string;
        week: string;
        month: string;
        allTime: string;
      }>();

    // Postgres counts are bigints, which arrive as strings.
    return new Map(
      rows.map((row) => [
        row.vendorId,
        {
          today: Number(row.today),
          week: Number(row.week),
          month: Number(row.month),
          allTime: Number(row.allTime),
        },
      ]),
    );
  }

  async getVendorDetail(id: string): Promise<{
    vendor: Partial<User>;
    products: Product[];
    productCount: number;
    serviceAreas: { id: string; name: string; stateName: string | null }[];
    payoutAccounts: AdminPayoutAccount[];
    wallet: { balance: number; entryCount: number };
    withdrawals: AdminWithdrawalRow[];
  }> {
    const vendor = await this.usersRepo.findOne({
      where: { id, role: Role.SELLER },
      relations: ['serviceAreas', 'serviceAreas.state'],
    });
    if (!vendor) throw new NotFoundException('Vendor not found');

    const [[products, productCount], accounts, summary, withdrawals] =
      await Promise.all([
        this.productsRepo.findAndCount({
          where: { vendorId: id },
          order: { createdAt: 'DESC' },
        }),
        // Removed ones too: a withdrawal can still point at an account retired since.
        this.accountsRepo.find({
          where: { userId: id },
          order: { isDefault: 'DESC', createdAt: 'ASC' },
        }),
        this.wallet.summaryOf(id),
        this.withdrawalsRepo.find({
          where: { userId: id },
          order: { createdAt: 'DESC' },
          take: 20,
        }),
      ]);

    const accountsById = new Map(accounts.map((a) => [a.id, a]));
    const { serviceAreas, ...profile } = vendor;

    return {
      vendor: this.stripSensitive(profile as User),
      products,
      productCount,
      serviceAreas: (serviceAreas ?? []).map((area) => ({
        id: area.id,
        name: area.name,
        stateName: area.state?.name ?? null,
      })),
      // Active first, removed last — the order an admin reads them in.
      payoutAccounts: accounts
        .sort((a, b) => ACCOUNT_ORDER[a.status] - ACCOUNT_ORDER[b.status])
        .map(toAdminPayoutAccount),
      wallet: summary,
      withdrawals: withdrawals.map((w) =>
        toAdminWithdrawalRow(w, accountsById.get(w.accountId)),
      ),
    };
  }

  // ─── Buyers ────────────────────────────────────────────────────────────────

  async getBuyers(query: {
    status?: SellerStatus;
    page?: number;
    limit?: number;
  }): Promise<PaginatedResult<Partial<User>>> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { role: Role.BUYER };
    if (query.status) where['status'] = query.status;

    const [items, total] = await this.usersRepo.findAndCount({
      where,
      select: [
        'id',
        'firstName',
        'lastName',
        'email',
        'phoneNumber',
        'status',
        'createdAt',
      ],
      skip,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Returns a buyer's profile and their orders matched by phoneNumber.
   * Buyers place orders via a public form (no account login), so we match
   * orders by the phone number stored on the buyer's user record.
   */
  async getBuyerDetail(id: string): Promise<{
    buyer: Partial<User>;
    orders: (Order & { lines: OrderLine[] })[];
    orderCount: number;
  }> {
    const buyer = await this.usersRepo.findOne({
      where: { id, role: Role.BUYER },
    });
    if (!buyer) throw new NotFoundException('Buyer not found');

    let orders: Order[] = [];
    let orderCount = 0;

    if (buyer.phoneNumber) {
      [orders, orderCount] = await this.ordersRepo.findAndCount({
        where: { buyerPhone: buyer.phoneNumber },
        relations: ['items', 'items.product', 'vendor'],
        order: { createdAt: 'DESC' },
        take: 50,
      });
    }

    // The vendor is a whole User row — password hash included — so only what the
    // page shows goes out.
    for (const order of orders) {
      if (order.vendor) {
        const { id, firstName, lastName, businessName } = order.vendor;
        order.vendor = { id, firstName, lastName, businessName } as User;
      }
    }

    return {
      buyer: this.stripSensitive(buyer),
      orders: orders.map((order) => ({
        ...order,
        lines: toOrderLines(order.items ?? []),
      })),
      orderCount,
    };
  }

  // ─── Products (platform-wide) ───────────────────────────────────────────────

  async getAllProducts(query: {
    vendorId?: string;
    isAvailable?: boolean;
    /** Product name, matched loosely. Blank is the same as not searching. */
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<PaginatedResult<Product>> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (query.vendorId) where['vendorId'] = query.vendorId;
    if (query.isAvailable !== undefined)
      where['isAvailable'] = query.isAvailable;

    // `ILike` rather than a full-text index: this list is browsed by an admin looking
    // for a product they can already half-name, not searched by buyers at volume.
    const term = query.search?.trim();
    if (term) where['name'] = ILike(`%${term}%`);

    const [items, total] = await this.productsRepo.findAndCount({
      where,
      relations: ['vendor'],
      select: {
        id: true,
        vendorId: true,
        name: true,
        description: true,
        price: true,
        imageUrl: true,
        isAvailable: true,
        isAddOn: true,
        createdAt: true,
        updatedAt: true,
        vendor: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          businessName: true,
          slug: true,
        },
      },
      skip,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ─── Orders (platform-wide) ─────────────────────────────────────────────────

  async getAllOrders(query: {
    status?: OrderStatus;
    vendorId?: string;
    page?: number;
    limit?: number;
  }): Promise<PaginatedResult<Order>> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (query.status) where['status'] = query.status;
    if (query.vendorId) where['vendorId'] = query.vendorId;

    const [items, total] = await this.ordersRepo.findAndCount({
      where,
      relations: ['items', 'items.choices', 'vendor', 'checkout'],
      select: {
        id: true,
        buyerName: true,
        buyerPhone: true,
        buyerEmail: true,
        totalAmount: true,
        platformFee: true,
        vendorAmount: true,
        fulfillmentType: true,
        status: true,
        deliveryAddress: true,
        notes: true,
        paidAt: true,
        createdAt: true,
        // Line items replace the old single product/quantity/unitPrice columns.
        items: {
          id: true,
          productId: true,
          productName: true,
          unitPrice: true,
          quantity: true,
          lineTotal: true,
          // What `toOrderLines` needs to read packs back whole.
          packs: true,
          unit: true,
          isAddOn: true,
          parentItemId: true,
          choices: { id: true, groupName: true, optionName: true, priceDelta: true },
        },
        // The payment reference now lives on the parent checkout.
        checkout: {
          id: true,
          reference: true,
          totalAmount: true,
          deliveryFee: true,
        },
        vendor: {
          id: true,
          firstName: true,
          lastName: true,
          businessName: true,
        },
      },
      skip,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return {
      // Each order's items as built — dishes with their packs, choices and extras.
      items: items.map((order) => ({
        ...order,
        lines: toOrderLines(order.items ?? []),
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ─── Transactions ──────────────────────────────────────────────────────────

  /**
   * One row per payment, which is what an admin reconciling against Paystack needs.
   *
   * `getAllOrders` lists the *vendor's* slice of each basket — the right unit for
   * fulfilment, the wrong one for money. A ₦17,950 basket split across two vendors shows
   * there as two rows totalling ₦16,450, with the delivery fee nowhere and nothing tying
   * them to the single charge the buyer actually saw. This is that charge.
   */
  async getTransactions(query: {
    status?: OrderStatus;
    search?: string;
    /** One rider's deliveries — what the rider page lists. */
    riderId?: string;
    /** Deliveries paid for or ready with nobody assigned yet — the dispatch queue. */
    needsRider?: boolean;
    /** Where the order was placed — storefront orders are the ones to call about. */
    source?: CheckoutSource;
    /** With a rider for longer than `DELIVERY_STALE_HOURS` and not delivered. */
    stuck?: boolean;
    page?: number;
    limit?: number;
  }): Promise<PaginatedResult<TransactionSummary>> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    const qb = this.checkoutsRepo
      .createQueryBuilder('checkout')
      .leftJoinAndSelect('checkout.orders', 'order')
      .leftJoinAndSelect('order.items', 'item')
      .leftJoinAndSelect('order.vendor', 'vendor')
      // Only what the summary shows — never the rider's account fields.
      .leftJoin('checkout.rider', 'rider')
      .addSelect([
        'rider.id',
        'rider.firstName',
        'rider.lastName',
        'rider.phoneNumber',
      ])
      .orderBy('checkout.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.status) {
      qb.andWhere('checkout.status = :status', { status: query.status });
    }

    if (query.riderId) {
      qb.andWhere('checkout.riderId = :riderId', { riderId: query.riderId });
    }

    if (query.needsRider) {
      qb.andWhere('checkout.riderId IS NULL')
        .andWhere('checkout.fulfillmentType = :delivery', {
          delivery: FulfillmentType.DELIVERY,
        })
        .andWhere('checkout.status IN (:...waiting)', {
          waiting: [OrderStatus.PAID, OrderStatus.READY],
        });
    }

    if (query.source) {
      if (!Object.values(CheckoutSource).includes(query.source)) {
        throw new BadRequestException('Unknown source');
      }
      qb.andWhere('checkout.source = :source', { source: query.source });
    }

    if (query.stuck) {
      qb.andWhere('checkout.status = :dispatched', {
        dispatched: OrderStatus.DISPATCHED,
      }).andWhere(`${DISPATCHED_AT_SQL('checkout')} <= :staleCutoff`, {
        staleCutoff: this.staleCutoff(),
      });
    }

    if (query.search?.trim()) {
      // Reference, buyer name or phone — whichever the admin happens to be holding.
      const term = `%${query.search.trim().replace(/[%_]/g, '')}%`;
      qb.andWhere(
        '(checkout.reference ILIKE :term OR checkout.buyerName ILIKE :term OR checkout.buyerPhone ILIKE :term)',
        { term },
      );
    }

    const [rows, total] = await qb.getManyAndCount();

    return {
      items: await this.summarise(rows),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Ask Paystack about one transaction, by hand.
   *
   * The sweep already does this on a timer, but an admin looking at a payment a buyer is
   * asking about should not have to wait up to ten minutes for a scheduler — nor go to
   * the Paystack dashboard and reconcile by eye. Same code path as everything else that
   * settles a payment, so a recovery here confirms the buyer and notifies the vendors
   * exactly as the webhook would have.
   */
  async verifyTransaction(reference: string): Promise<TransactionSummary> {
    await this.ordersService.confirmByReference(reference);

    const checkout = await this.checkoutsRepo.findOne({
      where: { reference },
      relations: ['orders', 'orders.items', 'orders.vendor', 'rider'],
    });
    if (!checkout) throw new NotFoundException('Transaction not found');

    const [summary] = await this.summarise([checkout]);
    return summary;
  }

  // ─── Order lifecycle ───────────────────────────────────────────────────────

  /** A rider has collected everything and left. */
  async dispatch(
    reference: string,
    adminId: string,
  ): Promise<TransactionSummary> {
    await this.lifecycle.markDispatched(reference, {
      type: StatusActor.ADMIN,
      id: adminId,
    });
    return this.verifyless(reference);
  }

  /**
   * The buyer has their order.
   *
   * Recorded as `RIDER` rather than `ADMIN`: until the rider app exists an admin is
   * doing this on a rider's behalf, and the audit trail should say what actually
   * happened rather than who happened to press the button. `actorId` still carries the
   * admin, so it is never anonymous.
   */
  async complete(
    reference: string,
    adminId: string,
  ): Promise<TransactionSummary> {
    await this.lifecycle.markCompleted(reference, {
      type: StatusActor.RIDER,
      id: adminId,
    });
    return this.verifyless(reference);
  }

  async overrideStatus(
    reference: string,
    status: OrderStatus,
    adminId: string,
    note?: string,
  ): Promise<TransactionSummary> {
    if (!status || !Object.values(OrderStatus).includes(status)) {
      throw new BadRequestException('A valid status is required');
    }
    await this.lifecycle.overrideCheckout(reference, status, adminId, note);
    return this.verifyless(reference);
  }

  /** Every status change on one order, oldest first. */
  async getStatusHistory(reference: string): Promise<OrderStatusEvent[]> {
    const checkout = await this.checkoutsRepo.findOne({
      where: { reference },
      select: ['id'],
    });
    if (!checkout) throw new NotFoundException('Transaction not found');

    return this.statusEvents.find({
      where: [{ checkoutId: checkout.id }],
      order: { createdAt: 'ASC' },
    });
  }

  /** Dispatched before this and not yet delivered is stuck on its way. */
  private staleCutoff(): Date {
    const hours = this.config?.get<number>('delivery.staleHours') ?? 3;
    return new Date(Date.now() - hours * 60 * 60_000);
  }

  private async summarise(
    checkouts: Checkout[],
  ): Promise<TransactionSummary[]> {
    const facts = await this.followUpFacts(checkouts);
    const staleCutoff = this.staleCutoff();
    return checkouts.map((checkout) =>
      toTransactionSummary(checkout, facts.get(checkout.id), staleCutoff),
    );
  }

  /**
   * For a page of transactions, in one query: when each last left with a rider, and
   * whether its buyer has signed in to the chat with the email they paid with.
   *
   * A row is still worth showing without these, so a failure here is logged and the rows
   * go out as "not on chat, not dispatched" rather than not at all.
   */
  private async followUpFacts(
    checkouts: Checkout[],
  ): Promise<Map<string, FollowUpFacts>> {
    if (checkouts.length === 0) return new Map();
    try {
      const rows: {
        id: string;
        dispatchedAt: Date | string | null;
        buyerOnChat: boolean;
      }[] = await this.checkoutsRepo.query(
        `SELECT c.id,
                CASE WHEN c.status IN ('DISPATCHED', 'COMPLETED')
                     THEN ${DISPATCHED_AT_SQL('c')} END AS "dispatchedAt",
                EXISTS (SELECT 1 FROM chat_accounts a
                         WHERE a.email = LOWER(TRIM(c."buyerEmail"))
                           AND a."lastSignedInAt" IS NOT NULL) AS "buyerOnChat"
           FROM checkouts c
          WHERE c.id = ANY($1::uuid[])`,
        [checkouts.map((checkout) => checkout.id)],
      );
      return new Map(
        rows.map((row) => [
          row.id,
          {
            buyerOnChat: row.buyerOnChat === true,
            dispatchedAt: row.dispatchedAt ? new Date(row.dispatchedAt) : null,
          },
        ]),
      );
    } catch (error) {
      this.logger.error(
        `Could not read follow-up details for transactions: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return new Map();
    }
  }

  /** The transaction as it stands now, without asking Paystack anything. */
  private async verifyless(reference: string): Promise<TransactionSummary> {
    const checkout = await this.checkoutsRepo.findOne({
      where: { reference },
      relations: ['orders', 'orders.items', 'orders.vendor', 'rider'],
    });
    if (!checkout) throw new NotFoundException('Transaction not found');
    const [summary] = await this.summarise([checkout]);
    return summary;
  }

  // ─── Riders ────────────────────────────────────────────────────────────────
  //
  // Until riders have an app, admin runs delivery: adds riders they have vetted, assigns
  // one to each delivery, and reaches them by phone. A rider's deliveries are the
  // transactions list filtered by `riderId`.

  /** A rider admin has vetted — approved at once, with no password to sign in with yet. */
  async createRider(
    dto: CreateRiderDto,
  ): Promise<{ message: string; data: RiderRow }> {
    const clash = await this.usersRepo.findOne({
      where: [
        { phoneNumber: dto.phoneNumber },
        ...(dto.email ? [{ email: dto.email }] : []),
      ],
      select: ['id', 'email', 'phoneNumber', 'role'],
    });
    if (clash) {
      throw new ConflictException(
        clash.phoneNumber === dto.phoneNumber
          ? `${dto.phoneNumber} already belongs to an account`
          : `${dto.email} already belongs to an account`,
      );
    }

    const rider = await this.usersRepo.save(
      this.usersRepo.create({
        firstName: dto.firstName,
        lastName: dto.lastName,
        phoneNumber: dto.phoneNumber,
        email: dto.email ?? syntheticRiderEmail(dto.phoneNumber),
        password: null,
        role: Role.RIDER,
        riderType: dto.riderType,
        riderNote: dto.note ?? null,
        status: SellerStatus.APPROVED,
        isEmailVerified: false,
      }),
    );

    const [row] = await this.riderRows([rider]);
    return { message: `${rider.fullName} added as a rider`, data: row };
  }

  async getRiders(query: {
    status?: SellerStatus;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<PaginatedResult<RiderRow>> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    const base: Record<string, unknown> = { role: Role.RIDER };
    if (query.status) base['status'] = query.status;

    // Name, phone or email — whichever the admin has.
    const term = query.search?.trim().replace(/[%_]/g, '');
    const where = term
      ? ['firstName', 'lastName', 'phoneNumber', 'email'].map((field) => ({
          ...base,
          [field]: ILike(`%${term}%`),
        }))
      : base;

    const [riders, total] = await this.usersRepo.findAndCount({
      where,
      select: RIDER_FIELDS,
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return {
      items: await this.riderRows(riders),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** One rider with their delivery counts. Their deliveries: transactions by `riderId`. */
  async getRider(id: string): Promise<RiderRow> {
    const rider = await this.usersRepo.findOne({
      where: { id, role: Role.RIDER },
      select: RIDER_FIELDS,
    });
    if (!rider) throw new NotFoundException('Rider not found');
    const [row] = await this.riderRows([rider]);
    return row;
  }

  /**
   * Put a rider on a delivery, or replace the one on it. Only an approved rider — a
   * suspended or rejected one is refused, as is anyone who is not a rider at all.
   */
  async assignRider(
    reference: string,
    riderId: string,
    adminId: string,
  ): Promise<TransactionSummary> {
    const rider = await this.usersRepo.findOne({
      where: { id: riderId, role: Role.RIDER },
      select: ['id', 'firstName', 'lastName', 'phoneNumber', 'status'],
    });
    if (!rider) throw new NotFoundException('Rider not found');
    if (rider.status !== SellerStatus.APPROVED) {
      throw new BadRequestException(
        `${rider.firstName} ${rider.lastName} is not an approved rider`,
      );
    }

    await this.lifecycle.assignRider(
      reference,
      {
        id: rider.id,
        name: `${rider.firstName} ${rider.lastName}`.trim(),
        phone: rider.phoneNumber,
      },
      { type: StatusActor.ADMIN, id: adminId },
    );
    return this.verifyless(reference);
  }

  /**
   * Riders as the admin panel shows them: profile plus how many deliveries each is
   * carrying now and has completed — counted in one grouped query, not one per rider.
   */
  private async riderRows(riders: User[]): Promise<RiderRow[]> {
    if (riders.length === 0) return [];

    const counts: {
      riderId: string;
      active: string;
      completed: string;
    }[] = await this.checkoutsRepo
      .createQueryBuilder('checkout')
      .select('checkout.riderId', 'riderId')
      .addSelect(
        `COUNT(*) FILTER (WHERE checkout.status IN (:...active))`,
        'active',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE checkout.status = :completed)`,
        'completed',
      )
      .where('checkout.riderId IN (:...ids)', { ids: riders.map((r) => r.id) })
      .setParameters({
        active: [OrderStatus.PAID, OrderStatus.READY, OrderStatus.DISPATCHED],
        completed: OrderStatus.COMPLETED,
      })
      .groupBy('checkout.riderId')
      .getRawMany();

    const byRider = new Map(counts.map((row) => [row.riderId, row]));

    return riders.map((rider) => ({
      id: rider.id,
      firstName: rider.firstName,
      lastName: rider.lastName,
      // A placeholder made up for a rider with no email is not an address to show.
      email: rider.email?.endsWith(SYNTHETIC_RIDER_EMAIL_DOMAIN)
        ? null
        : rider.email,
      phoneNumber: rider.phoneNumber,
      riderType: rider.riderType,
      riderNote: rider.riderNote,
      status: rider.status,
      createdAt: rider.createdAt,
      activeDeliveries: Number(byRider.get(rider.id)?.active ?? 0),
      completedDeliveries: Number(byRider.get(rider.id)?.completed ?? 0),
    }));
  }

  // ─── General user management (kept from previous version) ──────────────────

  async suspendUser(
    id: string,
  ): Promise<{ message: string; data: Partial<User> }> {
    const user = await this.findUserById(id);

    if (ADMIN_ROLES.includes(user.role)) {
      throw new BadRequestException(
        'Use the super-admin endpoint to manage admin accounts',
      );
    }
    if (user.status === SellerStatus.SUSPENDED) {
      throw new BadRequestException('User is already suspended');
    }

    user.status = SellerStatus.SUSPENDED;
    const saved = await this.usersRepo.save(user);

    return {
      message: `User ${saved.fullName} has been suspended`,
      data: this.stripSensitive(saved),
    };
  }

  async activateUser(
    id: string,
  ): Promise<{ message: string; data: Partial<User> }> {
    const user = await this.findUserById(id);

    if (ADMIN_ROLES.includes(user.role)) {
      throw new BadRequestException(
        'Use the super-admin endpoint to manage admin accounts',
      );
    }
    if (user.status === SellerStatus.APPROVED) {
      throw new BadRequestException('User is already active');
    }

    user.status = SellerStatus.APPROVED;
    const saved = await this.usersRepo.save(user);

    return {
      message: `User ${saved.fullName} has been activated`,
      data: this.stripSensitive(saved),
    };
  }

  async getUserById(
    id: string,
  ): Promise<{ message: string; data: Partial<User> }> {
    const user = await this.findUserById(id);
    return {
      message: 'User retrieved successfully',
      data: this.stripSensitive(user),
    };
  }

  // ─── Super Admin: admin management ─────────────────────────────────────────

  async createAdmin(
    dto: CreateAdminDto,
  ): Promise<{ message: string; data: Partial<User> }> {
    const existing = await this.usersRepo.findOne({
      where: { email: dto.email },
    });
    if (existing) throw new ConflictException('Email already in use');

    const admin = this.usersRepo.create({
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      password: dto.password, // BeforeInsert hook hashes it
      role: Role.ADMIN,
      status: SellerStatus.APPROVED, // Admins are active immediately
      isEmailVerified: true,
    });

    const saved = await this.usersRepo.save(admin);

    return {
      message: `Admin account created for ${saved.fullName}`,
      data: this.stripSensitive(saved),
    };
  }

  async getAdmins(query: {
    page?: number;
    limit?: number;
  }): Promise<PaginatedResult<Partial<User>>> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const [items, total] = await this.usersRepo.findAndCount({
      where: { role: In([Role.ADMIN]) },
      select: [
        'id',
        'firstName',
        'lastName',
        'email',
        'role',
        'status',
        'lastLoginAt',
        'createdAt',
      ],
      skip,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async suspendAdmin(
    id: string,
  ): Promise<{ message: string; data: Partial<User> }> {
    const admin = await this.usersRepo.findOne({
      where: { id, role: Role.ADMIN },
    });
    if (!admin) throw new NotFoundException('Admin not found');

    if (admin.status === SellerStatus.SUSPENDED) {
      throw new BadRequestException('Admin is already suspended');
    }

    admin.status = SellerStatus.SUSPENDED;
    const saved = await this.usersRepo.save(admin);

    return {
      message: `Admin ${saved.fullName} has been suspended`,
      data: this.stripSensitive(saved),
    };
  }

  async getPlatformStats(): Promise<{
    totalVendors: number;
    pendingVendors: number;
    totalRiders: number;
    pendingRiders: number;
    totalBuyers: number;
    totalOrders: number;
    paidOrders: number;
    totalRevenue: string;
    totalPlatformFee: string;
  }> {
    const [
      totalVendors,
      pendingVendors,
      totalRiders,
      pendingRiders,
      totalBuyers,
      totalOrders,
    ] = await Promise.all([
      this.usersRepo.count({ where: { role: Role.SELLER } }),
      this.usersRepo.count({
        where: { role: Role.SELLER, status: SellerStatus.PENDING },
      }),
      this.usersRepo.count({ where: { role: Role.RIDER } }),
      this.usersRepo.count({
        where: { role: Role.RIDER, status: SellerStatus.PENDING },
      }),
      this.usersRepo.count({ where: { role: Role.BUYER } }),
      this.ordersRepo.count(),
    ]);

    const revenueRow = await this.ordersRepo
      .createQueryBuilder('o')
      .select('SUM(o.totalAmount)', 'totalRevenue')
      .addSelect('SUM(o.platformFee)', 'totalPlatformFee')
      .where('o.status IN (:...statuses)', {
        statuses: [
          OrderStatus.PAID,
          OrderStatus.PROCESSING,
          OrderStatus.COMPLETED,
        ],
      })
      .getRawOne<{
        totalRevenue: string | null;
        totalPlatformFee: string | null;
      }>();

    const paidOrders = await this.ordersRepo.count({
      where: {
        status: In([
          OrderStatus.PAID,
          OrderStatus.PROCESSING,
          OrderStatus.COMPLETED,
        ]),
      },
    });

    return {
      totalVendors,
      pendingVendors,
      totalRiders,
      pendingRiders,
      totalBuyers,
      totalOrders,
      paidOrders,
      totalRevenue: revenueRow?.totalRevenue ?? '0',
      totalPlatformFee: revenueRow?.totalPlatformFee ?? '0',
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async findUserById(id: string): Promise<User> {
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private stripSensitive(user: User): Partial<User> {
    const u = { ...user } as Partial<User>;
    delete u.password;
    delete u.emailVerificationToken;
    delete u.emailVerificationTokenExpires;
    delete u.passwordResetToken;
    delete u.passwordResetTokenExpires;
    return u;
  }

  private async sendApprovalEmail(user: User, role: string): Promise<void> {
    try {
      await this.emailService.sendEmail({
        to: user.email,
        subject: `Your ${role} account has been approved – Recommend`,
        template: 'account-approved',
        context: { name: user.firstName, role },
      });
    } catch (error) {
      console.error('Failed to send approval email:', error);
    }
  }

  private async sendRejectionEmail(
    user: User,
    role: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.emailService.sendEmail({
        to: user.email,
        subject: `Your ${role} account application – Recommend`,
        template: 'account-rejected',
        context: { name: user.firstName, role, reason },
      });
    } catch (error) {
      console.error('Failed to send rejection email:', error);
    }
  }
}
