import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Product } from './entities/product.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

const PRODUCT_LIMIT = 20;

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
  ) {}

  async create(
    vendorId: string,
    dto: CreateProductDto,
  ): Promise<{ message: string; data: Product }> {
    const count = await this.productsRepository.count({ where: { vendorId } });
    if (count >= PRODUCT_LIMIT) {
      throw new BadRequestException(
        `Product limit (${PRODUCT_LIMIT}) reached. Delete an existing product before adding a new one.`,
      );
    }

    const product = this.productsRepository.create({
      vendorId,
      name: dto.name,
      description: dto.description ?? null,
      price: dto.price,
      imageUrl: dto.imageUrl ?? null,
      isAvailable: dto.isAvailable ?? true,
    });

    const saved = await this.productsRepository.save(product);
    return { message: 'Product created successfully', data: saved };
  }

  async findAllByVendor(
    vendorId: string,
    query: { page?: number; limit?: number },
  ): Promise<{
    message: string;
    data: {
      items: Product[];
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };
  }> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(50, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const [items, total] = await this.productsRepository.findAndCount({
      where: { vendorId },
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return {
      message: 'Products retrieved successfully',
      data: { items, total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async update(
    vendorId: string,
    productId: string,
    dto: UpdateProductDto,
  ): Promise<{ message: string; data: Product }> {
    const product = await this.findOwned(vendorId, productId);

    if (dto.name !== undefined) product.name = dto.name;
    if (dto.description !== undefined)
      product.description = dto.description ?? null;
    if (dto.price !== undefined) product.price = dto.price;
    if (dto.imageUrl !== undefined) product.imageUrl = dto.imageUrl ?? null;
    if (dto.isAvailable !== undefined) product.isAvailable = dto.isAvailable;

    const saved = await this.productsRepository.save(product);
    return { message: 'Product updated successfully', data: saved };
  }

  async remove(
    vendorId: string,
    productId: string,
  ): Promise<{ message: string }> {
    await this.findOwned(vendorId, productId);
    await this.productsRepository.delete({ id: productId });
    return { message: 'Product deleted successfully' };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async findOwned(
    vendorId: string,
    productId: string,
  ): Promise<Product> {
    const product = await this.productsRepository.findOne({
      where: { id: productId },
    });
    if (!product) throw new NotFoundException('Product not found');
    if (product.vendorId !== vendorId) {
      throw new ForbiddenException('You do not own this product');
    }
    return product;
  }

  /** Used by OrdersService to fetch a product during order creation */
  async findById(productId: string): Promise<Product | null> {
    return this.productsRepository.findOne({ where: { id: productId } });
  }

  /** Used by StoreService to list a vendor's available products */
  async findAvailableByVendor(vendorId: string): Promise<Product[]> {
    return this.productsRepository.find({
      where: { vendorId, isAvailable: true },
      order: { createdAt: 'ASC' },
    });
  }
}
