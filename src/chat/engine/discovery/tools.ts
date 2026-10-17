import { Logger } from '@nestjs/common';
import {
  CatalogPort,
  ProductSummary,
  VendorSummary,
} from '../../ports/catalog.port';
import { AreaSummary, LocationPort } from '../../ports/location.port';
import type { OrderingPort } from '../../ports/ordering.port';
import { orderForModel, orderPrices } from './my-orders';
import { sanitizeUntrusted } from './sanitize';
import { categoriesFor } from './synonyms';
import {
  AlternativeKind,
  Alternatives,
  findAlternatives,
} from './alternatives';
import { searchWithDishNames } from './dish-names';

export const DISCOVERY_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'request_teammate',
      description:
        'Bring in someone from the team. If the buyer asked for a person, they are handed ' +
        'over at once; otherwise they are asked whether they would like one. ONLY for what ' +
        'you cannot do with the other tools: a refund, cancelling an order, a complaint, a ' +
        'problem with an order already placed, a question about a payment, or a buyer ' +
        'clearly frustrated with you. Never for an ordinary search, even one that found ' +
        'nothing — suggest another search instead. After calling it, say nothing more.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description:
              'One short line for the teammate, e.g. "Asking where order REC-1A2B is"',
          },
          buyer_asked_for_person: {
            type: 'boolean',
            description:
              'True only if the buyer themselves asked to speak to a person, a human, ' +
              'customer care, an admin or the team.',
          },
        },
        required: ['reason', 'buyer_asked_for_person'],
      },
    },
  },
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
      name: 'search_products',
      description:
        'Find items matching what the buyer wants, optionally restricted to an area. ' +
        'Returns products with the vendor that sells each one.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'What the buyer is looking for, in their own words — a dish, a gadget, anything',
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
      description: 'Find vendors or stores, optionally by area or category.',
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
      description: 'List everything a specific vendor currently has available.',
      parameters: {
        type: 'object',
        properties: {
          vendorId: { type: 'string' },
        },
        required: ['vendorId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_my_orders',
      description:
        "This buyer's own orders, newest first: where each one is, what was in it, the " +
        'rider, the delivery or collection code, and where to collect a pickup. Use it ' +
        'for "where is my order?" and anything about an order they placed.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export interface ToolContext {
  catalog: CatalogPort;
  locations: LocationPort;
  /** Area already established for this conversation, used when the model omits one. */
  areaId: string | null;
  buyerText?: string;
  /** This conversation's orders — the only ones get_my_orders can ever show. */
  orders?: { port: OrderingPort; references: string[] };
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
  /** Set when the model asked for a teammate — the reason it gave. */
  handoverReason: string | null;
  /** The buyer asked for a person themselves, so no need to ask whether they want one. */
  buyerAskedForPerson: boolean;
  /**
   * Whether anything was actually searched this turn. "Found nothing" only means
   * something when it is true — small talk searches nothing.
   */
  searched: boolean;
  /** Searches with no exact match this turn, and what was offered instead — for the log. */
  unmet: UnmetSearchDraft[];
}

export interface UnmetSearchDraft {
  query: string;
  areaId: string | null;
  alternatives: AlternativeKind;
}

export function emptyHarvest(): ToolHarvest {
  return {
    vendors: [],
    products: [],
    areas: [],
    prices: [],
    resolvedAreaId: null,
    handoverReason: null,
    buyerAskedForPerson: false,
    searched: false,
    unmet: [],
  };
}

/** Long enough for a useful line to an admin, short enough to sit in an alert. */
const HANDOVER_REASON_LIMIT = 160;

const logger = new Logger('DiscoveryTools');

/** Enough for "my last few orders"; older ones are in the Orders tab. */
const MY_ORDERS_SHOWN = 5;

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
  // The model regularly passes an area *name* here ("ikeja") despite being told to pass
  // an id. That used to reach Postgres as a uuid parameter, throw, and drag the whole
  // model call into the keyword fallback — which read as the bot going stupid mid
  // conversation. Resolve names, and never let an unresolved value reach SQL.
  const areaId = await coerceAreaId(args.areaId, context, harvest);

  switch (name) {
    case 'request_teammate': {
      // Model-written, so treated like any untrusted text before an admin reads it.
      const reason =
        typeof args.reason === 'string'
          ? sanitizeUntrusted(args.reason, HANDOVER_REASON_LIMIT)
          : '';
      harvest.handoverReason = reason || 'The assistant asked for a teammate';
      harvest.buyerAskedForPerson = args.buyer_asked_for_person === true;
      return 'The buyer will be connected with the team. Do not reply further this turn.';
    }

    case 'resolve_area': {
      const text = typeof args.text === 'string' ? args.text : '';
      const areas = await context.locations.searchAreas(text);
      harvest.areas.push(...areas);

      if (areas.length === 1) harvest.resolvedAreaId = areas[0].id;

      return areas.length === 0
        ? 'No matching area. The platform may not cover it yet.'
        : JSON.stringify(areas);
    }

    case 'search_products': {
      harvest.searched = true;
      const query = typeof args.query === 'string' ? args.query : '';
      // In the buyer's words, then in vendors' — "ewa agoyin" is on menus as beans.
      const products = await searchWithDishNames(context.catalog, {
        text: query,
        areaId,
      });

      if (products.length > 0) {
        collectProducts(products, harvest);
        return JSON.stringify(await withOptions(context.catalog, products));
      }

      // Nothing exact. Offer the nearest thing that is available rather than a dead end,
      // and tell the model plainly that it is not what was asked for.
      const found = await findAlternatives(context.catalog, {
        text: query,
        areaId,
      });
      harvest.unmet.push({
        query,
        areaId: areaId ?? null,
        alternatives: found.kind,
      });
      collectProducts(found.products, harvest);
      harvest.vendors.push(...found.vendors);

      return alternativesForModel(query, found);
    }

    case 'search_vendors': {
      harvest.searched = true;
      const text = typeof args.query === 'string' ? args.query : undefined;
      const category =
        typeof args.category === 'string' ? args.category : undefined;
      const impliedByBuyer =
        !text && !category ? categoriesFor(context.buyerText) : [];

      let vendors = await context.catalog.searchVendors({
        text,
        category,
        categories: impliedByBuyer.length > 0 ? impliedByBuyer : undefined,
        areaId,
      });

      if (vendors.length === 0) {
        const categories = categoriesFor(
          [text, category].filter(Boolean).join(' '),
        );
        if (categories.length > 0) {
          vendors = await context.catalog.searchVendors({ categories, areaId });
        }
      }

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
      harvest.searched = true;
      const vendorId = typeof args.vendorId === 'string' ? args.vendorId : '';
      const products = await context.catalog.searchProducts({
        vendorId,
        limit: 20,
      });
      collectProducts(products, harvest);

      return products.length === 0
        ? 'That store has nothing available right now.'
        : JSON.stringify(await withOptions(context.catalog, products));
    }

    case 'get_my_orders': {
      const references = context.orders?.references ?? [];
      if (!context.orders || references.length === 0) {
        return 'This buyer has no orders on this device. If they ordered elsewhere, signing in shows them here.';
      }
      const orders = (await context.orders.port.listOrders(references)).slice(
        0,
        MY_ORDERS_SHOWN,
      );
      // Their own totals may be quoted back to them, so the guard must allow them.
      harvest.prices.push(...orders.flatMap(orderPrices));
      return JSON.stringify(orders.map(orderForModel));
    }

    default:
      logger.warn(`Model asked for unknown tool "${name}"`);
      return `Unknown tool "${name}".`;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turn whatever the model supplied for `areaId` into a real id, or nothing.
 *
 * A uuid passes through. A plain name is resolved when it maps to exactly one area.
 * Anything ambiguous falls back to the area already known for the conversation rather
 * than being guessed — searching the wrong area is worse than searching none.
 */
async function coerceAreaId(
  raw: unknown,
  context: ToolContext,
  harvest: ToolHarvest,
): Promise<string | undefined> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return context.areaId ?? undefined;
  }

  const value = raw.trim();
  if (UUID.test(value)) return value;

  const matches = await context.locations.searchAreas(value);
  if (matches.length === 1) {
    harvest.areas.push(matches[0]);
    harvest.resolvedAreaId = matches[0].id;
    return matches[0].id;
  }
  if (matches.length > 1) harvest.areas.push(...matches);

  logger.debug(`Model passed an unresolvable areaId: "${value}"`);
  return context.areaId ?? undefined;
}

function collectProducts(
  products: ProductSummary[],
  harvest: ToolHarvest,
): void {
  harvest.products.push(...products);
  harvest.prices.push(...products.map((product) => product.price));
}

/**
 * What the model is told when nothing matched exactly: that it did not, and what is
 * being offered instead — so it says both, in that order, and never passes an
 * alternative off as the thing asked for.
 */
function alternativesForModel(query: string, found: Alternatives): string {
  const asked = sanitizeUntrusted(query, 80);

  switch (found.kind) {
    case 'similar':
    case 'category':
      return JSON.stringify({
        exactMatch: false,
        note:
          `Nothing matches "${asked}" exactly. These are the closest available ` +
          (found.kind === 'similar'
            ? 'items (sharing some of the words). '
            : `items of the same kind (${found.category ?? 'similar'}). `) +
          'Say first that you could not find exactly what they asked for, then that ' +
          'these are close. They are shown as cards.',
        alternatives: found.products.map(forModel),
      });
    case 'vendors':
      return JSON.stringify({
        exactMatch: false,
        note:
          `Nothing matches "${asked}" exactly, and no similar items either. These ` +
          'vendors serve the area. Say first that you could not find it, then suggest ' +
          'they tap a vendor to see what they have. They are shown as cards.',
        vendors: found.vendors.map((vendor) => ({
          id: vendor.id,
          name: sanitizeUntrusted(vendor.name, 80),
          category: sanitizeUntrusted(vendor.category, 60),
          isOpen: vendor.isOpen,
        })),
      });
    case 'none':
      return 'Nothing available matching that, and nothing similar nearby.';
  }
}

/**
 * What the model is shown. Prices are included so it can reason about "cheapest", but
 * the system prompt forbids repeating them and the price guard enforces it.
 */
/**
 * Products as the model sees them, with what each dish comes with — its unit, its
 * choices and its extras — by name only, so it can answer "what proteins do they have?"
 * without a price to repeat.
 */
async function withOptions(catalog: CatalogPort, products: ProductSummary[]) {
  const dishes = new Map(
    (await catalog.getDishOptions(products.map((product) => product.id))).map(
      (dish) => [dish.productId, dish],
    ),
  );
  return products.map((product) => {
    const dish = dishes.get(product.id);
    if (!dish) return forModel(product);
    return {
      ...forModel(product),
      ...(dish.unit ? { soldPer: sanitizeUntrusted(dish.unit, 16) } : {}),
      ...(dish.choices.length > 0
        ? {
            choices: dish.choices.map((choice) => ({
              name: sanitizeUntrusted(choice.name, 60),
              required: choice.required,
              pickUpTo: choice.maxPick,
              options: choice.options
                .filter((option) => option.isAvailable)
                .map((option) => sanitizeUntrusted(option.name, 60)),
            })),
          }
        : {}),
      ...(dish.extras.length > 0
        ? {
            extras: dish.extras.map((extra) =>
              sanitizeUntrusted(extra.name, 60),
            ),
          }
        : {}),
    };
  });
}

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
