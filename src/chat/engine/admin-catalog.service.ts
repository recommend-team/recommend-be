import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConversationService } from '../conversation/conversation.service';
import { CATALOG_PORT } from '../ports/catalog.port';
import { LOCATION_PORT } from '../ports/location.port';
import type {
  CatalogPort,
  CategorySummary,
  DishChoice,
  ProductSummary,
  VendorSummary,
} from '../ports/catalog.port';
import type { AreaSummary, LocationPort } from '../ports/location.port';

/**
 * A product in the admin's order builder. A dish carries what it's sold with, so the
 * builder can build a pack as a buyer would; an extra carries empty lists.
 */
export interface AdminCatalogProduct extends ProductSummary {
  unit: string | null;
  /** The extras ticked on this dish, on sale — whole, so a pack can be built from a search. */
  extras: { id: string; name: string; price: number }[];
  choices: DishChoice[];
}

/** Everything the admin needs to choose the right shelf, in one reply. */
export interface AdminCatalogContext {
  /** Where the conversation already believes the buyer is. Null until someone says. */
  areaId: string | null;
  area: AreaSummary | null;
  areas: AreaSummary[];
}

@Injectable()
export class AdminCatalogService {
  constructor(
    @Inject(CATALOG_PORT) private readonly catalog: CatalogPort,
    @Inject(LOCATION_PORT) private readonly locations: LocationPort,
    private readonly conversations: ConversationService,
  ) {}

  /** The area picker, with whatever the conversation already knows preselected. */
  async context(
    conversationId: string,
    search?: string,
  ): Promise<AdminCatalogContext> {
    const conversation = await this.load(conversationId);
    const term = search?.trim();

    const [areas, area] = await Promise.all([
      term
        ? this.locations.searchAreas(term, 20)
        : this.locations.listAreas(50),
      conversation.areaId
        ? this.locations.getAreaById(conversation.areaId)
        : Promise.resolve(null),
    ]);

    return { areaId: conversation.areaId, area, areas };
  }

  async setArea(conversationId: string, areaId: string): Promise<AreaSummary> {
    await this.load(conversationId);

    const area = await this.locations.getAreaById(areaId);
    if (!area) throw new NotFoundException('No such area');

    await this.conversations.setArea(conversationId, areaId);
    return area;
  }

  async stores(
    conversationId: string,
    query: {
      areaId?: string;
      category?: string;
      search?: string;
      limit?: number;
    },
  ): Promise<VendorSummary[]> {
    const areaId = await this.resolveArea(conversationId, query.areaId);

    return this.catalog.searchVendors({
      text: query.search?.trim() || undefined,
      areaId: areaId ?? undefined,
      categories: categoryFilter(query.category),
      limit: query.limit ?? 20,
    });
  }

  async categories(
    conversationId: string,
    areaId?: string,
  ): Promise<CategorySummary[]> {
    const resolved = await this.resolveArea(conversationId, areaId);
    return this.catalog.listCategories({ areaId: resolved ?? undefined });
  }

  async products(
    conversationId: string,
    query: {
      areaId?: string;
      vendorId?: string;
      category?: string;
      search?: string;
      limit?: number;
    },
  ): Promise<AdminCatalogProduct[]> {
    const areaId = await this.resolveArea(conversationId, query.areaId);

    const products = await this.catalog.searchProducts({
      text: query.search?.trim() || undefined,
      vendorId: query.vendorId,
      areaId: areaId ?? undefined,
      categories: categoryFilter(query.category),
      limit: query.limit ?? 20,
    });

    // Browsing one store, the admin sees its extras too — flagged, so the builder lists
    // them apart and only alongside a meal. A search across stores never surfaces them,
    // as it never does for buyers. Checkout refuses an extra on its own either way.
    const listed =
      !query.vendorId || query.search?.trim()
        ? products
        : [...products, ...(await this.catalog.listAddOns([query.vendorId]))];
    return this.withOptions(listed);
  }

  /** Each dish with its unit, extras and choices, so the builder can build packs. */
  private async withOptions(
    products: ProductSummary[],
  ): Promise<AdminCatalogProduct[]> {
    const dishes = new Map(
      (
        await this.catalog.getDishOptions(
          products.filter((p) => !p.isAddOn).map((p) => p.id),
        )
      ).map((dish) => [dish.productId, dish]),
    );
    return products.map((product) => {
      const dish = dishes.get(product.id);
      return {
        ...product,
        unit: dish?.unit ?? null,
        extras:
          dish?.extras.map(({ id, name, price }) => ({ id, name, price })) ??
          [],
        choices: dish?.choices ?? [],
      };
    });
  }

  /** What the admin is looking at, falling back to what the conversation knows. */
  private async resolveArea(
    conversationId: string,
    requested?: string,
  ): Promise<string | null> {
    if (requested) return requested;
    const conversation = await this.load(conversationId);
    return conversation.areaId;
  }

  private async load(conversationId: string) {
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }
}
function categoryFilter(category?: string): string[] | undefined {
  const name = category?.trim();
  return name ? [name] : undefined;
}
