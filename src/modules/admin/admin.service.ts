import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
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
import { OrderStatus } from '../../common/enums/order-status.enum';
import { EmailService } from '../../common/services/email.service';
import { CreateAdminDto } from './dto/create-admin.dto';

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

function toTransactionSummary(checkout: Checkout): TransactionSummary {
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
    vendors: (checkout.orders ?? []).map((order) => ({
      orderId: order.id,
      vendorId: order.vendorId,
      vendorName: order.vendor?.businessName ?? null,
      status: order.status,
      subtotal: Number(order.totalAmount),
      vendorAmount: Number(order.vendorAmount),
      items: (order.items ?? []).map((item) => ({
        name: item.productName,
        quantity: item.quantity,
        lineTotal: Number(item.lineTotal),
      })),
    })),
  };
}

/** Roles that should never appear in buyer/vendor listings for regular admins */
const ADMIN_ROLES = [Role.ADMIN, Role.SUPER_ADMIN];

@Injectable()
export class AdminService {
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

  async getVendors(query: {
    status?: SellerStatus;
    page?: number;
    limit?: number;
  }): Promise<PaginatedResult<Partial<User>>> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { role: Role.SELLER };
    if (query.status) where['status'] = query.status;

    const [items, total] = await this.usersRepo.findAndCount({
      where,
      select: [
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
      ],
      skip,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getVendorDetail(id: string): Promise<{
    vendor: Partial<User>;
    products: Product[];
    productCount: number;
  }> {
    const vendor = await this.usersRepo.findOne({
      where: { id, role: Role.SELLER },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');

    const [products, productCount] = await this.productsRepo.findAndCount({
      where: { vendorId: id },
      order: { createdAt: 'DESC' },
    });

    return {
      vendor: this.stripSensitive(vendor),
      products,
      productCount,
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
    orders: Order[];
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
        relations: ['items', 'items.product'],
        order: { createdAt: 'DESC' },
        take: 50,
      });
    }

    return {
      buyer: this.stripSensitive(buyer),
      orders,
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
      relations: ['items', 'vendor', 'checkout'],
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

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
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
      .orderBy('checkout.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.status) {
      qb.andWhere('checkout.status = :status', { status: query.status });
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
      items: rows.map((checkout) => toTransactionSummary(checkout)),
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
      relations: ['orders', 'orders.items', 'orders.vendor'],
    });
    if (!checkout) throw new NotFoundException('Transaction not found');

    return toTransactionSummary(checkout);
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

  /** The transaction as it stands now, without asking Paystack anything. */
  private async verifyless(reference: string): Promise<TransactionSummary> {
    const checkout = await this.checkoutsRepo.findOne({
      where: { reference },
      relations: ['orders', 'orders.items', 'orders.vendor'],
    });
    if (!checkout) throw new NotFoundException('Transaction not found');
    return toTransactionSummary(checkout);
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
