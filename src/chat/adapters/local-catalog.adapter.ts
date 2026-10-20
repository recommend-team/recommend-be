import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository, type WhereExpressionBuilder } from 'typeorm';
import { User } from '../../modules/auth/entities/auth.entity';
import { Product } from '../../modules/products/entities/product.entity';
import { Role } from '../../common/enums/roles.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';
import { openingStatus } from '../../common/utils/opening-hours.util';
import {
  CatalogPort,
  CategorySummary,
  ProductSearchQuery,
  DishOptions,
  ProductSummary,
  VendorSearchQuery,
  VendorSummary,
} from '../ports/catalog.port';

/**
 * In-process implementation of `CatalogPort`.
 *
 * One of the few files permitted to import from `src/modules/`. When chat is extracted
 * into its own service this class becomes an HTTP client against the storefront
 * endpoints, and nothing else under `src/chat/` changes.
 */
@Injectable()
export class LocalCatalogAdapter implements CatalogPort {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
  ) {}

  async listCategories(query: { areaId?: string }): Promise<CategorySummary[]> {
    const qb = this.usersRepository
      .createQueryBuilder('vendor')
      .select('vendor.businessCategory', 'name')
      .addSelect('COUNT(*)', 'count')
      .where('vendor.role = :role', { role: Role.SELLER })
      .andWhere('vendor.status = :status', { status: SellerStatus.APPROVED })
      .andWhere('vendor.slug IS NOT NULL')
      .andWhere('vendor.businessCategory IS NOT NULL')
      .andWhere("vendor.businessCategory <> ''");
    if (query.areaId) {
      qb.andWhere(
        `EXISTS (
           SELECT 1 FROM vendor_service_areas vsa
           WHERE vsa."vendorId" = vendor.id AND vsa."areaId" = :areaId
         )`,
        { areaId: query.areaId },
      );
    }

    const rows = await qb
      .groupBy('vendor.businessCategory')
      .orderBy('COUNT(*)', 'DESC')
      .addOrderBy('vendor.businessCategory', 'ASC')
      .getRawMany<{ name: string; count: string }>();

    return rows.map((row) => ({
      name: row.name,
      storeCount: Number(row.count),
    }));
  }

  async searchVendors(query: VendorSearchQuery): Promise<VendorSummary[]> {
    const limit = clamp(query.limit, 8);

    const qb = this.usersRepository
      .createQueryBuilder('vendor')
      .leftJoinAndSelect('vendor.serviceAreas', 'area')
      .where('vendor.role = :role', { role: Role.SELLER })
      .andWhere('vendor.status = :status', { status: SellerStatus.APPROVED })
      .andWhere('vendor.slug IS NOT NULL');

    tokenise(query.text).forEach((token, index) => {
      const key = `v${index}`;
      qb.andWhere(
        new Brackets((where) => {
          where
            .where(`vendor.businessName ILIKE :${key}`, { [key]: `%${token}%` })
            .orWhere(`vendor.businessDescription ILIKE :${key}`, {
              [key]: `%${token}%`,
            });
        }),
      );
    });

    if (query.category) {
      qb.andWhere('vendor.businessCategory ILIKE :category', {
        category: `%${query.category}%`,
      });
    }

    if (query.categories?.length) {
      qb.andWhere('vendor.businessCategory IN (:...categories)', {
        categories: query.categories,
      });
    }

    // Area coverage is a join now, not a string match. The sub-query keeps the
    // vendor's full area list intact in the result rather than filtering it down.
    if (query.areaId) {
      qb.andWhere(
        `EXISTS (
           SELECT 1 FROM vendor_service_areas vsa
           WHERE vsa."vendorId" = vendor.id AND vsa."areaId" = :areaId
         )`,
        { areaId: query.areaId },
      );
    }

    // Open vendors first — a closed one is a dead end in a conversation. Paused ones
    // sort last in the query; who is inside their opening hours depends on the clock,
    // not a column, so a few more are read and sorted here.
    const vendors = await qb
      .orderBy('vendor.isOpen', 'DESC')
      .addOrderBy('vendor.createdAt', 'DESC')
      .take(limit * OVERFETCH)
      .getMany();

    return openFirst(
      vendors.map(toVendorSummary),
      (vendor) => vendor.isOpen,
    ).slice(0, limit);
  }

  async getVendorById(vendorId: string): Promise<VendorSummary | null> {
    const vendor = await this.usersRepository.findOne({
      where: { id: vendorId, role: Role.SELLER, status: SellerStatus.APPROVED },
      relations: ['serviceAreas'],
    });
    return vendor ? toVendorSummary(vendor) : null;
  }

  async searchProducts(query: ProductSearchQuery): Promise<ProductSummary[]> {
    const limit = clamp(query.limit, 8);

    const qb = this.productsRepository
      .createQueryBuilder('product')
      .innerJoinAndSelect('product.vendor', 'vendor')
      .where('product.isAvailable = true')
      // Add-ons are offered at checkout, never found on their own: someone asking for
      // food is not shown "extra beef".
      .andWhere('product.isAddOn = false')
      .andWhere('vendor.status = :status', { status: SellerStatus.APPROVED });

    if (query.vendorId) {
      qb.andWhere('product.vendorId = :vendorId', { vendorId: query.vendorId });
    }

    // Every word must appear, in either field, but not necessarily adjacently. A single
    // contiguous LIKE would miss "phone charger" against "iPhone Fast Charger 20W" and
    // "chicken rice" against "Jollof Rice with Chicken" — both things buyers type.
    // With `matchAny`, one word is enough: the close matches offered when that finds
    // nothing.
    const tokens = tokenise(query.text);
    const matches = (where: WhereExpressionBuilder, token: string, i: number) =>
      where.orWhere(
        new Brackets((field) => {
          field
            .where(`product.name ILIKE :t${i}`, { [`t${i}`]: `%${token}%` })
            .orWhere(`product.description ILIKE :t${i}`, {
              [`t${i}`]: `%${token}%`,
            });
        }),
      );

    if (query.matchAny && tokens.length > 0) {
      qb.andWhere(
        new Brackets((where) => {
          tokens.forEach((token, i) => matches(where, token, i));
        }),
      );
    } else {
      tokens.forEach((token, i) => {
        qb.andWhere(new Brackets((where) => matches(where, token, i)));
      });
    }

    if (query.categories?.length) {
      qb.andWhere('vendor.businessCategory IN (:...categories)', {
        categories: query.categories,
      });
    }

    if (query.areaId) {
      qb.andWhere(
        `EXISTS (
           SELECT 1 FROM vendor_service_areas vsa
           WHERE vsa."vendorId" = vendor.id AND vsa."areaId" = :areaId
         )`,
        { areaId: query.areaId },
      );
    }

    // Open vendors' items first, as in searchVendors.
    const products = await qb
      .orderBy('vendor.isOpen', 'DESC')
      .addOrderBy('product.createdAt', 'DESC')
      .take(limit * OVERFETCH)
      .getMany();

    return openFirst(
      products.map(toProductSummary),
      (product) => product.vendorIsOpen,
    ).slice(0, limit);
  }

  async getProductById(productId: string): Promise<ProductSummary | null> {
    const product = await this.productsRepository.findOne({
      where: { id: productId },
      relations: ['vendor'],
    });
    return product ? toProductSummary(product) : null;
  }

  async listAddOns(vendorIds: string[]): Promise<ProductSummary[]> {
    if (vendorIds.length === 0) return [];

    const products = await this.productsRepository.find({
      where: { vendorId: In(vendorIds), isAddOn: true, isAvailable: true },
      relations: ['vendor'],
      // Cheapest first: water before a jug of zobo is the order people scan in.
      order: { price: 'ASC', name: 'ASC' },
      take: 60,
    });
    return products.map(toProductSummary);
  }

  async getDishOptions(productIds: string[]): Promise<DishOptions[]> {
    if (productIds.length === 0) return [];

    const products = await this.productsRepository.find({
      where: { id: In([...new Set(productIds)]) },
      relations: [
        'extras',
        'extras.vendor',
        'choiceGroups',
        'choiceGroups.options',
      ],
    });
    return products.map((product) => ({
      productId: product.id,
      name: product.name,
      unit: product.unit ?? null,
      choices: [...(product.choiceGroups ?? [])]
        .sort((a, b) => a.position - b.position)
        .map((group) => ({
          id: group.id,
          name: group.name,
          required: group.required,
          minPick: group.minPick,
          maxPick: group.maxPick,
          options: [...(group.options ?? [])]
            .sort((a, b) => a.position - b.position)
            .map((option) => ({
              id: option.id,
              name: option.name,
              priceDelta: Number(option.priceDelta),
              isAvailable: option.isAvailable,
            })),
        })),
      extras: (product.extras ?? [])
        .filter((extra) => extra.isAvailable)
        .sort(
          (a, b) =>
            Number(a.price) - Number(b.price) || a.name.localeCompare(b.name),
        )
        .map(toProductSummary),
    }));
  }
}

/** How many times the limit a search reads, so open vendors can be sorted to the top. */
const OVERFETCH = 3;

/** Open ones first, keeping the query's order within each half. */
function openFirst<T>(items: T[], isOpen: (item: T) => boolean): T[] {
  return [...items.filter(isOpen), ...items.filter((item) => !isOpen(item))];
}

function clamp(value: number | undefined, fallback: number): number {
  return Math.min(20, Math.max(1, value ?? fallback));
}

/**
 * Split a search phrase into words that each have to match.
 *
 * Single characters are dropped (they match nearly everything) and the list is capped, so
 * a very long phrase cannot turn into a query with dozens of ANDed LIKEs. `%` and `_` are
 * stripped because a raw wildcard from a buyer would silently widen the search.
 */
function tokenise(text: string | undefined, maxTokens = 6): string[] {
  if (!text) return [];

  return text
    .replace(/[%_]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(
      (token) => token.length > 1 && !JOINING_WORDS.has(token.toLowerCase()),
    )
    .slice(0, maxTokens);
}

/**
 * Words that join what a buyer wants rather than name it. Required to match, "rice and
 * beans" found nothing unless an item's name said "and" — "Rice & Beans" did not.
 */
const JOINING_WORDS = new Set(['and', 'with', 'or', 'of', 'the', 'some']);

function toVendorSummary(vendor: User): VendorSummary {
  return {
    id: vendor.id,
    name: vendor.businessName ?? 'Unnamed store',
    slug: vendor.slug,
    category: vendor.businessCategory,
    areas: (vendor.serviceAreas ?? []).map((area) => ({
      id: area.id,
      name: area.name,
    })),
    ...openNow(vendor),
    logoUrl: vendor.businessLogoUrl,
  };
}

function toProductSummary(product: Product): ProductSummary {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: Number(product.price),
    imageUrl: product.imageUrl,
    vendorId: product.vendorId,
    vendorName: product.vendor?.businessName ?? null,
    // Lets a product card open its vendor's menu via GET /store/:slug.
    vendorSlug: product.vendor?.slug ?? null,
    ...vendorOpenNow(product.vendor),
    isAddOn: product.isAddOn,
  };
}

/** Open right now — the switch and the opening hours together. */
function openNow(vendor: User): Pick<VendorSummary, 'isOpen' | 'opensAt'> {
  const status = openingStatus(vendor, new Date());
  return {
    isOpen: status.openNow,
    opensAt: status.opensAt?.toISOString() ?? null,
  };
}

function vendorOpenNow(
  vendor: User | undefined,
): Pick<ProductSummary, 'vendorIsOpen' | 'vendorOpensAt'> {
  // An extra read through its dish arrives without its vendor; checkout still decides.
  if (!vendor) return { vendorIsOpen: true, vendorOpensAt: null };
  const { isOpen, opensAt } = openNow(vendor);
  return { vendorIsOpen: isOpen, vendorOpensAt: opensAt };
}
