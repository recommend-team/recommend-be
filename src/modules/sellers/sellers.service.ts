import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../auth/entities/auth.entity';
import { Order } from '../orders/entities/order.entity';
import { VendorType } from '../../common/enums/vendor-type.enum';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  UpdateRegisteredKycDto,
  UpdateNonRegisteredKycDto,
} from './dto/update-kyc.dto';
import { UpdatePayoutDto } from './dto/update-payout.dto';
import { LocationsService } from '../locations/locations.service';

type PayoutFields =
  | 'bankName'
  | 'bankCode'
  | 'bankAccountNumber'
  | 'bankAccountName';

export interface VendorProfileResponse {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  phoneNumber: string | null;
  role: string;
  status: string;
  vendorType: VendorType | null;
  profilePicture: string | null;
  slug: string | null;
  businessName: string | null;
  businessAddress: string | null;
  businessDescription: string | null;
  businessCategory: string | null;
  serviceAreas: { id: string; name: string; stateId: string }[];
  businessLogoUrl: string | null;
  businessBannerUrl: string | null;
  whatsappNumber: string | null;
  isOpen: boolean;
  operatingHours: Record<
    string,
    { isOpen: boolean; open: string; close: string }
  > | null;
  orderQuota: number | null;
  monthlyOrderCount: number;
  // KYC
  cacDocumentUrl: string | null;
  tinDocumentUrl: string | null;
  ninDocumentUrl: string | null;
  passportPhotoUrl: string | null;
  bankStatementUrl: string | null;
  utilityBillUrl: string | null;
  // Payout
  bankName: string | null;
  bankCode: string | null;
  bankAccountNumber: string | null;
  bankAccountName: string | null;
  // Meta
  profileCompleteness: number;
  storefrontUrl: string | null;
  isEmailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class SellersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Order)
    private readonly ordersRepository: Repository<Order>,
    private readonly locationsService: LocationsService,
  ) {}

  // ─── Profile ───────────────────────────────────────────────────────────────

  async getProfile(
    userId: string,
  ): Promise<{ message: string; data: VendorProfileResponse }> {
    const vendor = await this.findVendor(userId);
    return {
      message: 'Profile retrieved successfully',
      data: this.buildProfileResponse(vendor),
    };
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<{ message: string; data: VendorProfileResponse }> {
    const vendor = await this.findVendor(userId);

    // Apply only provided fields
    if (dto.businessName !== undefined) {
      vendor.businessName = dto.businessName;
      // Auto-generate slug on first businessName set only
      if (!vendor.slug) {
        vendor.slug = await this.generateUniqueSlug(dto.businessName);
      }
    }
    if (dto.businessAddress !== undefined)
      vendor.businessAddress = dto.businessAddress;
    if (dto.businessDescription !== undefined)
      vendor.businessDescription = dto.businessDescription;
    if (dto.businessCategory !== undefined)
      vendor.businessCategory = dto.businessCategory;
    // Sending areaIds replaces coverage wholesale. Unknown or deactivated ids are
    // rejected by the service rather than silently dropped.
    if (dto.areaIds !== undefined) {
      vendor.serviceAreas = await this.locationsService.findActiveAreasByIds(
        dto.areaIds,
      );
    }
    if (dto.businessLogoUrl !== undefined)
      vendor.businessLogoUrl = dto.businessLogoUrl;
    if (dto.businessBannerUrl !== undefined)
      vendor.businessBannerUrl = dto.businessBannerUrl;
    if (dto.whatsappNumber !== undefined)
      vendor.whatsappNumber = dto.whatsappNumber;
    if (dto.isOpen !== undefined) vendor.isOpen = dto.isOpen;
    if (dto.operatingHours !== undefined)
      vendor.operatingHours = dto.operatingHours as Record<
        string,
        { isOpen: boolean; open: string; close: string }
      >;

    const saved = await this.usersRepository.save(vendor);

    return {
      message: 'Profile updated successfully',
      data: this.buildProfileResponse(saved),
    };
  }

  // ─── KYC ───────────────────────────────────────────────────────────────────

  async updateKyc(
    userId: string,
    body: UpdateRegisteredKycDto | UpdateNonRegisteredKycDto,
  ): Promise<{ message: string; data: VendorProfileResponse }> {
    const vendor = await this.findVendor(userId);

    if (!vendor.vendorType) {
      throw new BadRequestException(
        'Vendor type is not set. Please complete your profile first.',
      );
    }

    if (vendor.vendorType === VendorType.REGISTERED) {
      const dto = body as UpdateRegisteredKycDto;

      // Reject if non-registered fields are present
      const nonRegFields = [
        'ninDocumentUrl',
        'passportPhotoUrl',
        'bankStatementUrl',
        'utilityBillUrl',
      ];
      const hasWrongFields = nonRegFields.some(
        (f) => f in body && (body as Record<string, unknown>)[f] !== undefined,
      );
      if (hasWrongFields) {
        throw new BadRequestException(
          'Registered vendors should submit CAC and TIN documents only',
        );
      }

      if (dto.cacDocumentUrl !== undefined)
        vendor.cacDocumentUrl = dto.cacDocumentUrl;
      if (dto.tinDocumentUrl !== undefined)
        vendor.tinDocumentUrl = dto.tinDocumentUrl;
    } else {
      const dto = body as UpdateNonRegisteredKycDto;

      // Reject if registered fields are present
      const regFields = ['cacDocumentUrl', 'tinDocumentUrl'];
      const hasWrongFields = regFields.some(
        (f) => f in body && (body as Record<string, unknown>)[f] !== undefined,
      );
      if (hasWrongFields) {
        throw new BadRequestException(
          'Non-registered vendors should submit NIN, passport photo, bank statement and utility bill only',
        );
      }

      if (dto.ninDocumentUrl !== undefined)
        vendor.ninDocumentUrl = dto.ninDocumentUrl;
      if (dto.passportPhotoUrl !== undefined)
        vendor.passportPhotoUrl = dto.passportPhotoUrl;
      if (dto.bankStatementUrl !== undefined)
        vendor.bankStatementUrl = dto.bankStatementUrl;
      if (dto.utilityBillUrl !== undefined)
        vendor.utilityBillUrl = dto.utilityBillUrl;
    }

    const saved = await this.usersRepository.save(vendor);

    return {
      message:
        'KYC documents submitted successfully. Your account will be reviewed by our team.',
      data: this.buildProfileResponse(saved),
    };
  }

  // ─── Payout details ────────────────────────────────────────────────────────

  async updatePayout(
    userId: string,
    dto: UpdatePayoutDto,
  ): Promise<{
    message: string;
    data: Pick<User, PayoutFields>;
  }> {
    const vendor = await this.findVendor(userId);

    vendor.bankName = dto.bankName;
    vendor.bankCode = dto.bankCode;
    vendor.bankAccountNumber = dto.bankAccountNumber;
    vendor.bankAccountName = dto.bankAccountName;

    const saved = await this.usersRepository.save(vendor);

    return {
      message: 'Payout details updated successfully',
      data: {
        bankName: saved.bankName,
        bankCode: saved.bankCode,
        bankAccountNumber: saved.bankAccountNumber,
        bankAccountName: saved.bankAccountName,
      },
    };
  }

  // ─── Orders dashboard ──────────────────────────────────────────────────────

  async getOrders(
    vendorId: string,
    query: { status?: OrderStatus; page?: number; limit?: number },
  ): Promise<{
    message: string;
    data: {
      items: Order[];
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };
  }> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(50, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { vendorId };
    if (query.status) where['status'] = query.status;

    const [items, total] = await this.ordersRepository.findAndCount({
      where,
      relations: ['items', 'items.product'],
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return {
      message: 'Orders retrieved successfully',
      data: { items, total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── Earnings dashboard ────────────────────────────────────────────────────

  async getEarnings(vendorId: string): Promise<{
    message: string;
    data: {
      grossTotal: number;
      netTotal: number;
      platformFeeTotal: number;
      monthlyBreakdown: { month: string; gross: number; net: number }[];
    };
  }> {
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

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async findVendor(userId: string): Promise<User> {
    const vendor = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['serviceAreas'],
    });
    if (!vendor) throw new NotFoundException('Vendor not found');
    return vendor;
  }

  private buildProfileResponse(vendor: User): VendorProfileResponse {
    const storefrontUrl = vendor.slug ? `/store/${vendor.slug}` : null;

    return {
      id: vendor.id,
      email: vendor.email,
      firstName: vendor.firstName,
      lastName: vendor.lastName,
      fullName: vendor.fullName,
      phoneNumber: vendor.phoneNumber,
      role: vendor.role,
      status: vendor.status,
      vendorType: vendor.vendorType,
      profilePicture: vendor.profilePicture,
      slug: vendor.slug,
      storefrontUrl,
      businessName: vendor.businessName,
      businessAddress: vendor.businessAddress,
      businessDescription: vendor.businessDescription,
      businessCategory: vendor.businessCategory,
      serviceAreas: (vendor.serviceAreas ?? []).map((area) => ({
        id: area.id,
        name: area.name,
        stateId: area.stateId,
      })),
      businessLogoUrl: vendor.businessLogoUrl,
      businessBannerUrl: vendor.businessBannerUrl,
      whatsappNumber: vendor.whatsappNumber,
      isOpen: vendor.isOpen,
      operatingHours: vendor.operatingHours,
      orderQuota: vendor.orderQuota,
      monthlyOrderCount: vendor.monthlyOrderCount,
      cacDocumentUrl: vendor.cacDocumentUrl,
      tinDocumentUrl: vendor.tinDocumentUrl,
      ninDocumentUrl: vendor.ninDocumentUrl,
      passportPhotoUrl: vendor.passportPhotoUrl,
      bankStatementUrl: vendor.bankStatementUrl,
      utilityBillUrl: vendor.utilityBillUrl,
      bankName: vendor.bankName,
      bankCode: vendor.bankCode,
      bankAccountNumber: vendor.bankAccountNumber,
      bankAccountName: vendor.bankAccountName,
      profileCompleteness: this.computeCompleteness(vendor),
      isEmailVerified: vendor.isEmailVerified,
      createdAt: vendor.createdAt,
      updatedAt: vendor.updatedAt,
    };
  }

  /**
   * Generates a unique kebab-case slug from a business name.
   * Appends -2, -3, etc. if the base slug is already taken.
   */
  private async generateUniqueSlug(businessName: string): Promise<string> {
    const base = businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);

    let slug = base;
    let counter = 2;

    while (await this.usersRepository.findOne({ where: { slug } })) {
      slug = `${base}-${counter}`;
      counter++;
    }

    return slug;
  }

  /**
   * Computes a 0–100 completeness score based on key profile fields.
   * Helps vendors know what's still missing before admin review.
   */
  private computeCompleteness(vendor: User): number {
    const checks: boolean[] = [
      !!vendor.businessName,
      !!vendor.businessAddress,
      !!vendor.businessCategory,
      (vendor.serviceAreas?.length ?? 0) > 0,
      !!vendor.businessLogoUrl,
      !!vendor.whatsappNumber,
      !!vendor.bankAccountNumber,
      // KYC: at least one doc
      vendor.vendorType === VendorType.REGISTERED
        ? !!(vendor.cacDocumentUrl || vendor.tinDocumentUrl)
        : !!(
            vendor.ninDocumentUrl ||
            vendor.passportPhotoUrl ||
            vendor.bankStatementUrl ||
            vendor.utilityBillUrl
          ),
    ];

    const filled = checks.filter(Boolean).length;
    return Math.round((filled / checks.length) * 100);
  }
}
