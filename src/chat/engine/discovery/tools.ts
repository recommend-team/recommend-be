import { Logger } from '@nestjs/common';
import {
  CatalogPort,
  ProductSummary,
  VendorSummary,
} from '../../ports/catalog.port';
import { AreaSummary, LocationPort } from '../../ports/location.port';
import { sanitizeUntrusted } from './sanitize';

/**
 * The tools the model may call. All of them are READ-ONLY — nothing here can change
 * state, spend money, or create an order. That is the containment: the worst a bad
 * model turn can do is search for the wrong thing.
 */
export const DISCOVERY_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'resolve_area',
      description:
        'Turn what a buyer said about where they are ("yaba", "I dey Lekki") into ' +
        'real areas the platform serves. Call this before searching if the area is unknown.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'What the buyer said about their location',
          },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_food',
      description:
        'Find dishes matching what the buyer wants, optionally restricted to an area. ' +
        'Returns products with the restaurant that sells each one.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The dish, e.g. "jollof rice"',
          },
          areaId: { type: 'string', description: 'Area id from resolve_area' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_vendors',
      description:
        'Find restaurants or stores, optionally by area or category.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          areaId: { type: 'string' },
          category: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_vendor_menu',
      description:
        'List everything a specific restaurant currently has available.',
      parameters: {
        type: 'object',
        properties: {
          vendorId: { type: 'string' },
        },
        required: ['vendorId'],
      },
    },
  },
];

export interface ToolContext {
  catalog: CatalogPort;
  locations: LocationPort;
  /** Area already established for this conversation, used when the model omits one. */
  areaId: string | null;
}

/** Everything the tools surfaced during one turn. */
export interface ToolHarvest {
  vendors: VendorSummary[];
  products: ProductSummary[];
  areas: AreaSummary[];
  /** Every price a tool actually returned — the allow-list for the price guard. */
  prices: number[];
  /** Set when the model resolved the buyer's area this turn. */
  resolvedAreaId: string | null;
}

export function emptyHarvest(): ToolHarvest {
  return {
    vendors: [],
    products: [],
    areas: [],
    prices: [],
    resolvedAreaId: null,
  };
}

const logger = new Logger('DiscoveryTools');

/**
 * Runs one tool call and folds its output into the harvest. The string returned is
 * what the model sees; the harvest is what the buyer eventually sees, and the two are
 * built from the same data so they cannot disagree.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
  harvest: ToolHarvest,
): Promise<string> {
  const areaId =
    typeof args.areaId === 'string'
      ? args.areaId
      : (context.areaId ?? undefined);

  switch (name) {
    case 'resolve_area': {
      const text = typeof args.text === 'string' ? args.text : '';
      const areas = await context.locations.searchAreas(text);
      harvest.areas.push(...areas);

      if (areas.length === 1) harvest.resolvedAreaId = areas[0].id;

      return areas.length === 0
        ? 'No matching area. The platform may not cover it yet.'
        : JSON.stringify(areas);
    }

    case 'search_food': {
      const query = typeof args.query === 'string' ? args.query : '';
      const products = await context.catalog.searchProducts({
        text: query,
        areaId,
      });
      collectProducts(products, harvest);

      return products.length === 0
        ? 'Nothing available matching that.'
        : JSON.stringify(products.map(forModel));
    }

    case 'search_vendors': {
      const vendors = await context.catalog.searchVendors({
        text: typeof args.query === 'string' ? args.query : undefined,
        category: typeof args.category === 'string' ? args.category : undefined,
        areaId,
      });
      harvest.vendors.push(...vendors);

      return vendors.length === 0
        ? 'No open stores match that.'
        : JSON.stringify(
            vendors.map((vendor) => ({
              id: vendor.id,
              name: sanitizeUntrusted(vendor.name, 80),
              category: sanitizeUntrusted(vendor.category, 60),
              isOpen: vendor.isOpen,
            })),
          );
    }

    case 'get_vendor_menu': {
      const vendorId = typeof args.vendorId === 'string' ? args.vendorId : '';
      const products = await context.catalog.searchProducts({
        vendorId,
        limit: 20,
      });
      collectProducts(products, harvest);

      return products.length === 0
        ? 'That store has nothing available right now.'
        : JSON.stringify(products.map(forModel));
    }

    default:
      logger.warn(`Model asked for unknown tool "${name}"`);
      return `Unknown tool "${name}".`;
  }
}

function collectProducts(
  products: ProductSummary[],
  harvest: ToolHarvest,
): void {
  harvest.products.push(...products);
  harvest.prices.push(...products.map((product) => product.price));
}

/**
 * What the model is shown. Prices are included so it can reason about "cheapest", but
 * the system prompt forbids repeating them and the price guard enforces it.
 */
function forModel(product: ProductSummary) {
  return {
    id: product.id,
    // Vendor-authored text — neutralised before it enters the model context.
    name: sanitizeUntrusted(product.name, 80),
    price: product.price,
    vendorId: product.vendorId,
    vendorName: sanitizeUntrusted(product.vendorName, 80),
  };
}
