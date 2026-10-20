/**
 * Read-only view of the platform catalogue, shaped for chat.
 *
 * These types are chat-local on purpose — they are NOT the platform's entities. That
 * is what lets the local adapter be swapped for an HTTP client without any engine code
 * changing. See `src/chat/README.md`.
 */

export const CATALOG_PORT = Symbol('CATALOG_PORT');

export interface VendorSummary {
  id: string;
  name: string;
  slug: string | null;
  category: string | null;
  areas: { id: string; name: string }[];
  /** Can be bought from right now: not paused, and inside opening hours if set. */
  isOpen: boolean;
  /** When a closed vendor next opens (ISO) — null if open, paused, or no hours open. */
  opensAt: string | null;
  logoUrl: string | null;
}

export interface ProductSummary {
  id: string;
  name: string;
  description: string | null;
  price: number;
  imageUrl: string | null;
  vendorId: string;
  vendorName: string | null;
  /** Needed so a product card can open its vendor menu via GET /store/:slug. */
  vendorSlug: string | null;
  /** Its vendor can be bought from right now — see `VendorSummary.isOpen`. */
  vendorIsOpen: boolean;
  /** When its closed vendor next opens (ISO), or null. */
  vendorOpensAt: string | null;
  /** Sold only with a main item from the same vendor. Never in search results. */
  isAddOn: boolean;
}

/**
 * What a dish is sold with (PRODUCT_OPTIONS_PLAN.md): its unit, the choices the buyer
 * answers ("Choose your protein"), and the vendor's extras ticked on it.
 */
export interface DishOptions {
  productId: string;
  name: string;
  /** "portion" — what the price is per. Null: no unit. */
  unit: string | null;
  choices: DishChoice[];
  /** Ticked on this dish and on sale. */
  extras: ProductSummary[];
}

export interface DishChoice {
  id: string;
  name: string;
  required: boolean;
  minPick: number;
  maxPick: number;
  options: {
    id: string;
    name: string;
    /** Added per portion. */
    priceDelta: number;
    isAvailable: boolean;
  }[];
}

export interface VendorSearchQuery {
  /** Free text from the buyer, matched against business name and description. */
  text?: string;
  /** Admin-managed area id — resolved from what the buyer said about where they are. */
  areaId?: string;
  category?: string;
  categories?: string[];
  limit?: number;
}

export interface ProductSearchQuery {
  text?: string;
  /**
   * Match items with *any* of the words rather than all of them — "rice and beans"
   * then finds Jollof Rice and Beans & Plantain. For close matches when the exact search
   * found nothing, never for the first search.
   */
  matchAny?: boolean;
  vendorId?: string;
  areaId?: string;
  categories?: string[];
  limit?: number;
}

/**
 * A kind of shop, counted.
 *
 * Derived from what vendors actually are rather than a fixed taxonomy — `businessCategory`
 * is free text a vendor supplied, so the only honest list is the one in the data. Scoped
 * to an area, it also stops offering a category nothing nearby can fulfil.
 */
export interface CategorySummary {
  name: string;
  storeCount: number;
}

export interface CatalogPort {
  /** The categories with at least one open-or-closed approved store, newest first. */
  listCategories(query: { areaId?: string }): Promise<CategorySummary[]>;
  searchVendors(query: VendorSearchQuery): Promise<VendorSummary[]>;
  getVendorById(vendorId: string): Promise<VendorSummary | null>;
  searchProducts(query: ProductSearchQuery): Promise<ProductSummary[]>;
  getProductById(productId: string): Promise<ProductSummary | null>;
  /** The available add-ons of these vendors — every extra they sell. */
  listAddOns(vendorIds: string[]): Promise<ProductSummary[]>;
  /** Each dish's unit, choices and extras. Products with none come back empty. */
  getDishOptions(productIds: string[]): Promise<DishOptions[]>;
}
