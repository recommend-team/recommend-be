import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { Product, ProductUnit } from './entities/product.entity';
import {
  ProductChoiceGroup,
  ProductChoiceOption,
} from './entities/product-choice.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import type { ChoiceGroupInput } from './dto/product-options.dto';

const PRODUCT_LIMIT = 20;

/** A choice as clients see it, options in the vendor's order. */
export interface ChoiceGroupView {
  id: string;
  name: string;
  required: boolean;
  minPick: number;
  maxPick: number;
  options: {
    id: string;
    name: string;
    /** Per portion. */
    priceDelta: number;
    isAvailable: boolean;
  }[];
}

/**
 * A product with what makes it a dish: its unit, the extras ticked on it (ids from the
 * vendor's extras list) and its choices. Every product response carries these, so a
 * client never has to ask twice.
 */
export type ProductView = Omit<Product, 'extras' | 'choiceGroups'> & {
  unit: ProductUnit | null;
  extraIds: string[];
  /** On an extra: the dishes it is ticked on. Empty on a dish. */
  dishIds: string[];
  choices: ChoiceGroupView[];
};

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    @InjectRepository(ProductChoiceGroup)
    private readonly groupsRepository: Repository<ProductChoiceGroup>,
    private readonly dataSource: DataSource,
  ) {}

  async create(
    vendorId: string,
    dto: CreateProductDto,
  ): Promise<{ message: string; data: ProductView }> {
    const count = await this.productsRepository.count({ where: { vendorId } });
    if (count >= PRODUCT_LIMIT) {
      throw new BadRequestException(
        `Product limit (${PRODUCT_LIMIT}) reached. Delete an existing product before adding a new one.`,
      );
    }
    this.assertOptionsFit(dto.isAddOn ?? false, dto);

    const id = await this.dataSource.transaction(async (manager) => {
      const product = await manager.save(
        manager.create(Product, {
          vendorId,
          name: dto.name,
          description: dto.description ?? null,
          price: dto.price,
          imageUrl: dto.imageUrl ?? null,
          isAvailable: dto.isAvailable ?? true,
          isAddOn: dto.isAddOn ?? false,
          unit: dto.unit ?? null,
        }),
      );
      await this.applyOptions(manager, product, dto);
      return product.id;
    });

    return {
      message: 'Product created successfully',
      data: await this.viewOf(id),
    };
  }

  async findAllByVendor(
    vendorId: string,
    query: { page?: number; limit?: number },
  ): Promise<{
    message: string;
    data: {
      items: ProductView[];
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
      data: {
        items: await this.viewsOf(items),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async update(
    vendorId: string,
    productId: string,
    dto: UpdateProductDto,
  ): Promise<{ message: string; data: ProductView }> {
    const product = await this.findOwned(vendorId, productId);
    const becomesExtra = dto.isAddOn ?? product.isAddOn;
    this.assertOptionsFit(becomesExtra, dto);

    await this.dataSource.transaction(async (manager) => {
      if (dto.name !== undefined) product.name = dto.name;
      if (dto.description !== undefined)
        product.description = dto.description ?? null;
      if (dto.price !== undefined) product.price = dto.price;
      if (dto.imageUrl !== undefined) product.imageUrl = dto.imageUrl ?? null;
      if (dto.isAvailable !== undefined) product.isAvailable = dto.isAvailable;
      if (dto.unit !== undefined) product.unit = dto.unit ?? null;

      if (dto.isAddOn !== undefined && dto.isAddOn !== product.isAddOn) {
        product.isAddOn = dto.isAddOn;
        if (dto.isAddOn) {
          // Now an extra: an extra has no extras or choices of its own.
          await this.clearOptions(manager, product.id);
        } else {
          // No longer an extra: it comes off every dish it was ticked on.
          await manager.query(
            `DELETE FROM product_extras WHERE "extraId" = $1`,
            [product.id],
          );
        }
      }

      await manager.save(product);
      await this.applyOptions(manager, product, dto);
    });

    return {
      message: 'Product updated successfully',
      data: await this.viewOf(product.id),
    };
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

  /** An extra is sold with a dish; it has no extras or choices of its own. */
  private assertOptionsFit(
    isExtra: boolean,
    dto: {
      extraIds?: string[];
      choices?: ChoiceGroupInput[];
      dishIds?: string[];
    },
  ): void {
    if (isExtra && (dto.extraIds?.length || dto.choices?.length)) {
      throw new BadRequestException(
        'An extra can’t have its own extras or choices — add those to the dish.',
      );
    }
    if (!isExtra && dto.dishIds?.length) {
      throw new BadRequestException(
        'Only an extra goes on dishes — tick extras on the dish instead.',
      );
    }
  }

  /** Writes the extras ticked on a dish and its choices, when the request sends them. */
  private async applyOptions(
    manager: EntityManager,
    product: Product,
    dto: {
      extraIds?: string[];
      choices?: ChoiceGroupInput[];
      dishIds?: string[];
    },
  ): Promise<void> {
    if (dto.extraIds !== undefined) {
      await this.setExtras(manager, product, dto.extraIds);
    }
    if (dto.dishIds !== undefined && product.isAddOn) {
      await this.setDishes(manager, product, dto.dishIds);
    }
    if (dto.choices !== undefined) {
      await this.setChoices(manager, product.id, dto.choices);
    }
  }

  /** Only this vendor's own extras, and never the dish itself. */
  private async setExtras(
    manager: EntityManager,
    product: Product,
    extraIds: string[],
  ): Promise<void> {
    const ids = [...new Set(extraIds)].filter((id) => id !== product.id);
    if (ids.length > 0) {
      const extras = await manager.find(Product, {
        where: { id: In(ids), vendorId: product.vendorId, isAddOn: true },
        select: ['id'],
      });
      if (extras.length !== ids.length) {
        throw new BadRequestException(
          'Some of those extras aren’t on this vendor’s extras list.',
        );
      }
    }
    await manager.query(`DELETE FROM product_extras WHERE "productId" = $1`, [
      product.id,
    ]);
    if (ids.length > 0) {
      await manager.query(
        `INSERT INTO product_extras ("productId", "extraId")
         SELECT $1, unnest($2::uuid[])`,
        [product.id, ids],
      );
    }
  }

  /** The dishes an extra goes on — only this vendor's own dishes. */
  private async setDishes(
    manager: EntityManager,
    extra: Product,
    dishIds: string[],
  ): Promise<void> {
    const ids = [...new Set(dishIds)].filter((id) => id !== extra.id);
    if (ids.length > 0) {
      const dishes = await manager.find(Product, {
        where: { id: In(ids), vendorId: extra.vendorId, isAddOn: false },
        select: ['id'],
      });
      if (dishes.length !== ids.length) {
        throw new BadRequestException(
          'Some of those dishes aren’t on this vendor’s menu.',
        );
      }
    }
    await manager.query(`DELETE FROM product_extras WHERE "extraId" = $1`, [
      extra.id,
    ]);
    if (ids.length > 0) {
      await manager.query(
        `INSERT INTO product_extras ("productId", "extraId")
         SELECT unnest($2::uuid[]), $1`,
        [extra.id, ids],
      );
    }
  }

  /**
   * Replaces the dish's choices with the list sent. Groups and options sent with their id
   * are updated in place — a buyer's cart holding "Fish" keeps working after the vendor
   * renames the group — the rest are added; anything left out is removed.
   */
  private async setChoices(
    manager: EntityManager,
    productId: string,
    choices: ChoiceGroupInput[],
  ): Promise<void> {
    const existing = await manager.find(ProductChoiceGroup, {
      where: { productId },
      relations: ['options'],
    });
    const existingGroups = new Map(existing.map((g) => [g.id, g]));
    const keptGroupIds = new Set<string>();

    for (const [position, input] of choices.entries()) {
      const current = input.id ? existingGroups.get(input.id) : undefined;
      if (input.id && !current) {
        throw new BadRequestException(
          'One of those choices doesn’t belong to this dish.',
        );
      }
      const group = await manager.save(
        manager.create(ProductChoiceGroup, {
          ...(current ? { id: current.id } : {}),
          productId,
          name: input.name,
          required: input.required,
          minPick: input.minPick,
          maxPick: input.maxPick,
          position,
        }),
      );
      keptGroupIds.add(group.id);

      const existingOptions = new Map(
        (current?.options ?? []).map((o) => [o.id, o]),
      );
      const keptOptionIds = new Set<string>();
      for (const [optionPosition, option] of input.options.entries()) {
        if (option.id && !existingOptions.has(option.id)) {
          throw new BadRequestException(
            `An option on "${input.name}" doesn’t belong to it.`,
          );
        }
        const saved = await manager.save(
          manager.create(ProductChoiceOption, {
            ...(option.id ? { id: option.id } : {}),
            groupId: group.id,
            name: option.name,
            priceDelta: option.priceDelta,
            isAvailable: option.isAvailable,
            position: optionPosition,
          }),
        );
        keptOptionIds.add(saved.id);
      }
      const goneOptions = [...existingOptions.keys()].filter(
        (id) => !keptOptionIds.has(id),
      );
      if (goneOptions.length > 0) {
        await manager.delete(ProductChoiceOption, { id: In(goneOptions) });
      }
    }

    const goneGroups = [...existingGroups.keys()].filter(
      (id) => !keptGroupIds.has(id),
    );
    if (goneGroups.length > 0) {
      await manager.delete(ProductChoiceGroup, { id: In(goneGroups) });
    }
  }

  private async clearOptions(
    manager: EntityManager,
    productId: string,
  ): Promise<void> {
    await manager.query(`DELETE FROM product_extras WHERE "productId" = $1`, [
      productId,
    ]);
    await manager.delete(ProductChoiceGroup, { productId });
  }

  private async viewOf(productId: string): Promise<ProductView> {
    const product = await this.productsRepository.findOne({
      where: { id: productId },
    });
    if (!product) throw new NotFoundException('Product not found');
    const [view] = await this.viewsOf([product]);
    return view;
  }

  /** Products with their extras and choices, read in two queries for the whole list. */
  async viewsOf(products: Product[]): Promise<ProductView[]> {
    if (products.length === 0) return [];
    const ids = products.map((p) => p.id);

    const [links, groups] = await Promise.all([
      this.dataSource.query<{ productId: string; extraId: string }[]>(
        `SELECT "productId", "extraId" FROM product_extras
          WHERE "productId" = ANY($1::uuid[]) OR "extraId" = ANY($1::uuid[])`,
        [ids],
      ),
      this.groupsRepository.find({
        where: { productId: In(ids) },
        relations: ['options'],
        order: { position: 'ASC' },
      }),
    ]);

    return products.map((product) => {
      const { extras: _extras, choiceGroups: _groups, ...rest } = product;
      void _extras;
      void _groups;
      return {
        ...rest,
        unit: product.unit ?? null,
        extraIds: links
          .filter((link) => link.productId === product.id)
          .map((link) => link.extraId),
        dishIds: links
          .filter((link) => link.extraId === product.id)
          .map((link) => link.productId),
        choices: groups
          .filter((group) => group.productId === product.id)
          .map(toChoiceView),
      };
    });
  }

  /** Used by OrdersService to fetch a product during order creation */
  async findById(productId: string): Promise<Product | null> {
    return this.productsRepository.findOne({ where: { id: productId } });
  }

  /** Used by StoreService to list a vendor's available products, with their options. */
  async findAvailableByVendor(vendorId: string): Promise<ProductView[]> {
    const products = await this.productsRepository.find({
      where: { vendorId, isAvailable: true },
      order: { createdAt: 'ASC' },
    });
    return this.viewsOf(products);
  }
}

export function toChoiceView(group: ProductChoiceGroup): ChoiceGroupView {
  return {
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
  };
}
