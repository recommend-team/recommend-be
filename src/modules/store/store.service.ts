import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../auth/entities/auth.entity';
import { ProductsService } from '../products/products.service';

export interface StorefrontResponse {
  vendor: {
    id: string;
    businessName: string | null;
    businessDescription: string | null;
    businessCategory: string | null;
    businessAreas: string[] | null;
    businessLogoUrl: string | null;
    businessBannerUrl: string | null;
    whatsappNumber: string | null;
    isOpen: boolean;
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
  }[];
}

@Injectable()
export class StoreService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly productsService: ProductsService,
  ) {}

  async getStorefront(
    slug: string,
  ): Promise<{ message: string; data: StorefrontResponse }> {
    const vendor = await this.usersRepository.findOne({ where: { slug } });
    if (!vendor) throw new NotFoundException('Storefront not found');

    const products = await this.productsService.findAvailableByVendor(
      vendor.id,
    );

    return {
      message: 'Storefront retrieved successfully',
      data: {
        vendor: {
          id: vendor.id,
          businessName: vendor.businessName,
          businessDescription: vendor.businessDescription,
          businessCategory: vendor.businessCategory,
          businessAreas: vendor.businessAreas,
          businessLogoUrl: vendor.businessLogoUrl,
          businessBannerUrl: vendor.businessBannerUrl,
          whatsappNumber: vendor.whatsappNumber,
          isOpen: vendor.isOpen,
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
        })),
      },
    };
  }
}
