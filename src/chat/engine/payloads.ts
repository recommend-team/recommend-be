import { MessagePayload } from '../conversation/entities/message.entity';
import { ProductSummary, VendorSummary } from '../ports/catalog.port';
import { AreaSummary } from '../ports/location.port';

/**
 * Builders for the structured half of a reply.
 *
 * Everything the buyer sees as a number — price above all — comes from here, straight
 * out of a tool result, never from model prose. That split is what makes the price
 * guard meaningful rather than decorative.
 */

/** Dishes grouped under the restaurant that sells them. */
export function productListPayload(products: ProductSummary[]): MessagePayload {
  const byVendor = new Map<
    string,
    {
      vendorId: string;
      vendorName: string | null;
      items: {
        id: string;
        name: string;
        price: number;
        imageUrl: string | null;
      }[];
    }
  >();

  for (const product of products) {
    const group = byVendor.get(product.vendorId) ?? {
      vendorId: product.vendorId,
      vendorName: product.vendorName,
      items: [],
    };

    // The same dish can arrive from several tool calls in one turn.
    if (!group.items.some((item) => item.id === product.id)) {
      group.items.push({
        id: product.id,
        name: product.name,
        price: product.price,
        imageUrl: product.imageUrl,
      });
    }

    byVendor.set(product.vendorId, group);
  }

  return { kind: 'product_list', data: { vendors: [...byVendor.values()] } };
}

export function vendorListPayload(vendors: VendorSummary[]): MessagePayload {
  const seen = new Set<string>();
  const unique = vendors.filter((vendor) => {
    if (seen.has(vendor.id)) return false;
    seen.add(vendor.id);
    return true;
  });

  return {
    kind: 'vendor_list',
    data: {
      vendors: unique.map((vendor) => ({
        id: vendor.id,
        name: vendor.name,
        slug: vendor.slug,
        category: vendor.category,
        isOpen: vendor.isOpen,
        logoUrl: vendor.logoUrl,
        areas: vendor.areas.map((area) => area.name),
      })),
    },
  };
}

/** Offered when what the buyer said about their location matches more than one area. */
export function areaChoicesPayload(areas: AreaSummary[]): MessagePayload {
  return {
    kind: 'choices',
    data: {
      purpose: 'area',
      options: areas.map((area) => ({
        id: area.id,
        label: area.stateName ? `${area.name}, ${area.stateName}` : area.name,
      })),
    },
  };
}

/** Every price in a payload, for the price guard's allow-list. */
export function pricesIn(products: ProductSummary[]): number[] {
  return products.map((product) => product.price);
}
