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
  isOpen: boolean;
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
}
