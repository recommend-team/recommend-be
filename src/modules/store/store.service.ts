import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, IsNull } from 'typeorm';
import { User } from '../auth/entities/auth.entity';
import { ProductsService } from '../products/products.service';
import { SellerStatus } from '../../common/enums/seller-status.enum';
import type { ChoiceGroupView } from '../products/products.service';
import { Role } from '../../common/enums/roles.enum';
import { openingFields } from '../../common/utils/opening-hours.util';

export interface StorefrontResponse {
  vendor: {
    id: string;
    businessName: string | null;
    businessDescription: string | null;
    businessCategory: string | null;
    serviceAreas: { id: string; name: string }[];
    businessLogoUrl: string | null;
    businessBannerUrl: string | null;
    whatsappNumber: string | null;
    /** Can be bought from right now: not paused, and inside opening hours if set. */
    isOpen: boolean;
    /** When it next opens (ISO) — null if open, paused, or no hours open. */
    opensAt: string | null;
    /** When the current opening ends (ISO) — null if closed or no end. */
    closesAt: string | null;
    operatingHours: Record<
      string,
      { isOpen: boolean; open: string; close: string }
    > | null;
    slug: string | null;
  };
  products: {
    id: string;
    name: string;
    description: string | null;
    price: number;
    imageUrl: string | null;
    isAvailable: boolean;
    /** Sold only with a main item from this vendor — shown apart, under extras. */
    isAddOn: boolean;
    /** What the price is for — "per portion". Null shows no unit. */
    unit: string | null;
    /** On a dish: the vendor's extras that go with it (ids in `products`). */
    extraIds: string[];
    /** On a dish: its choices. Options include unavailable ones, marked so. */
    choices: ChoiceGroupView[];
  }[];
  /** What delivery costs, so the cart shows the true total before checkout. */
  deliveryFee: number;
  pickupEnabled: boolean;
  deliveryEtaMinutes: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface StoreListItem {
  id: string;
  businessName: string | null;
  businessDescription: string | null;
  businessCategory: string | null;
  serviceAreas: { id: string; name: string }[];
  businessLogoUrl: string | null;
  slug: string | null;
  /** Can be bought from right now — see `StorefrontResponse`. */
  isOpen: boolean;
  opensAt: string | null;
  closesAt: string | null;
  createdAt: Date;
}

@Injectable()
export class StoreService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly productsService: ProductsService,
    private readonly config: ConfigService,
  ) {}

  async getAllStores(
    page = 1,
    limit = 20,
  ): Promise<{
    message: string;
    data: PaginatedResult<StoreListItem>;
  }> {
    const validPage = Math.max(1, page);
    const validLimit = Math.min(100, Math.max(1, limit));
    const skip = (validPage - 1) * validLimit;

    const [items, total] = await this.usersRepository.findAndCount({
      where: {
        role: Role.SELLER,
        status: SellerStatus.APPROVED,
        slug: Not(IsNull()),
      },
      select: [
        'id',
        'businessName',
        'businessDescription',
        'businessCategory',
        'businessLogoUrl',
        'slug',
        'isOpen',
        'operatingHours',
        'createdAt',
      ],
      relations: ['serviceAreas'],
      skip,
      take: validLimit,
      order: { createdAt: 'DESC' },
    });

    const now = new Date();
    return {
      message: 'Stores retrieved successfully',
      data: {
        items: items.map((vendor) => ({
          id: vendor.id,
          businessName: vendor.businessName,
          businessDescription: vendor.businessDescription,
          businessCategory: vendor.businessCategory,
          serviceAreas: (vendor.serviceAreas ?? []).map((area) => ({
            id: area.id,
            name: area.name,
          })),
          businessLogoUrl: vendor.businessLogoUrl,
          slug: vendor.slug,
          ...openForBuyers(vendor, now),
          createdAt: vendor.createdAt,
        })),
        total,
        page: validPage,
        limit: validLimit,
        totalPages: Math.ceil(total / validLimit),
      },
    };
  }

  async getStorefront(
    slug: string,
  ): Promise<{ message: string; data: StorefrontResponse }> {
    // Only an approved vendor's shop opens. A pending, suspended or deactivated vendor's
    // link reads as unavailable rather than showing a shop no one can buy from.
    const vendor = await this.usersRepository.findOne({
      where: { slug, role: Role.SELLER, status: SellerStatus.APPROVED },
      relations: ['serviceAreas'],
    });
    if (!vendor) throw new NotFoundException('Storefront not found');

    const products = await this.productsService.findAvailableByVendor(
      vendor.id,
    );

    const now = new Date();
    return {
      message: 'Storefront retrieved successfully',
      data: {
        vendor: {
          id: vendor.id,
          businessName: vendor.businessName,
          businessDescription: vendor.businessDescription,
          businessCategory: vendor.businessCategory,
          serviceAreas: (vendor.serviceAreas ?? []).map((area) => ({
            id: area.id,
            name: area.name,
          })),
          businessLogoUrl: vendor.businessLogoUrl,
          businessBannerUrl: vendor.businessBannerUrl,
          whatsappNumber: vendor.whatsappNumber,
          ...openForBuyers(vendor, now),
          operatingHours: vendor.operatingHours,
          slug: vendor.slug,
        },
        products: products.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          price: Number(p.price),
          imageUrl: p.imageUrl,
          isAvailable: p.isAvailable,
          isAddOn: p.isAddOn,
          unit: p.unit,
          extraIds: p.extraIds,
          choices: p.choices,
        })),
        // The same settings checkout charges by, so the total shown is the total paid.
        deliveryFee:
          Math.round((this.config.get<number>('delivery.feeNgn') ?? 0) * 100) /
          100,
        pickupEnabled:
          this.config.get<boolean>('delivery.pickupEnabled') ?? false,
        deliveryEtaMinutes:
          this.config.get<number>('chat.deliveryEtaMinutes') ?? 30,
      },
    };
  }
}

/** A buyer's `isOpen` means "can I buy now" — the switch and the opening hours together. */
function openForBuyers(vendor: User, now: Date) {
  const { openNow, opensAt, closesAt } = openingFields(vendor, now);
  return { isOpen: openNow, opensAt, closesAt };
}
