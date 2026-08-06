import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { User } from '../../modules/auth/entities/auth.entity';
import { Product } from '../../modules/products/entities/product.entity';
import { Role } from '../../common/enums/roles.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';
import {
  CatalogPort,
  ProductSearchQuery,
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

  async searchVendors(query: VendorSearchQuery): Promise<VendorSummary[]> {
    const limit = clamp(query.limit, 8);

    const qb = this.usersRepository
      .createQueryBuilder('vendor')
      .leftJoinAndSelect('vendor.serviceAreas', 'area')
      .where('vendor.role = :role', { role: Role.SELLER })
      .andWhere('vendor.status = :status', { status: SellerStatus.APPROVED })
      .andWhere('vendor.slug IS NOT NULL');

    if (query.text) {
      qb.andWhere(
        new Brackets((where) => {
          where
            .where('vendor.businessName ILIKE :text', {
              text: `%${query.text}%`,
            })
            .orWhere('vendor.businessDescription ILIKE :text', {
              text: `%${query.text}%`,
            });
        }),
      );
    }

    if (query.category) {
      qb.andWhere('vendor.businessCategory ILIKE :category', {
        category: `%${query.category}%`,
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

    // Open vendors first — a closed one is a dead end in a conversation.
    const vendors = await qb
      .orderBy('vendor.isOpen', 'DESC')
      .addOrderBy('vendor.createdAt', 'DESC')
      .take(limit)
      .getMany();

    return vendors.map(toVendorSummary);
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
      .andWhere('vendor.status = :status', { status: SellerStatus.APPROVED });

    if (query.vendorId) {
      qb.andWhere('product.vendorId = :vendorId', { vendorId: query.vendorId });
    }

    if (query.text) {
      qb.andWhere(
        new Brackets((where) => {
          where
            .where('product.name ILIKE :text', { text: `%${query.text}%` })
            .orWhere('product.description ILIKE :text', {
              text: `%${query.text}%`,
            });
        }),
      );
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

    const products = await qb
      .orderBy('vendor.isOpen', 'DESC')
      .addOrderBy('product.createdAt', 'DESC')
      .take(limit)
      .getMany();

    return products.map(toProductSummary);
  }

  async getProductById(productId: string): Promise<ProductSummary | null> {
    const product = await this.productsRepository.findOne({
      where: { id: productId },
      relations: ['vendor'],
    });
    return product ? toProductSummary(product) : null;
  }
}

function clamp(value: number | undefined, fallback: number): number {
  return Math.min(20, Math.max(1, value ?? fallback));
}

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
    isOpen: vendor.isOpen,
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
  };
}
