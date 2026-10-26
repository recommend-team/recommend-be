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
import {
  broadKindOf,
  categoriesFor,
  examplesOf,
  kindsList,
  spokenKind,
  standardCategoriesOf,
} from './synonyms';
import {
  AlternativeKind,
  Alternatives,
  findAlternatives,
  vendorCategoriesFor,
} from './alternatives';
import { searchWithDishNames } from './dish-names';
import { describeOpening } from '../../../common/utils/opening-hours.util';

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
        'Turn what a buyer said about where they are ("yaba", "I dey Lekki", "Badore", ' +
        '"Chevron", "Akinwale Road Ajah") into the areas we use. Knows neighbourhoods, ' +
        'estates and streets inside each area. Call this before searching if the area ' +
        'is unknown, and whenever the buyer names a new place.',
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
      const areas = await context.locations.searchAreas(text, 5, {
        guesses: true,
      });
      harvest.areas.push(...areas);

      // A guess ("Leki") waits for the buyer to say yes.
      if (areas.length === 1 && !areas[0].guess) {
        harvest.resolvedAreaId = areas[0].id;
      }

      if (areas.length === 0) {
        // Counted, so the team can say which area it is in for next time.
        await context.locations
          .recordUnplaced(text)
          .catch((error: unknown) =>
            logger.warn(
              `Could not record unplaced "${text}": ${error instanceof Error ? error.message : 'unknown'}`,
            ),
          );
        const known = await context.locations.listAreas(200);
        return JSON.stringify({
          matched: false,
          note:
            'This place matches none of our areas or the places we know inside them. ' +
            'Do NOT say we do not cover it, or that it is not one of our areas — say you ' +
            "don't recognise it yet. If you know which of these areas it is in " +
            'or next to, suggest that one and ask the buyer to confirm ("Is Badore ' +
            'around Ajah?"). Otherwise ask which of these areas they are in or closest to.',
          ourAreas: known.map((area) => area.name),
        });
      }

      return JSON.stringify(
        areas.map((area) => ({
          id: area.id,
          name: area.name,
          state: area.stateName,
          ...(area.via
            ? {
                buyerSaid: sanitizeUntrusted(area.via, 60),
                note: `${sanitizeUntrusted(area.via, 60)} is in ${area.name} — say so, and carry on in ${area.name}.`,
              }
            : {}),
          ...(area.guess
            ? {
                guess: true,
                note: `Spelled differently from anything we know — ask "Did you mean ${area.name}?" before using it.`,
              }
            : {}),
        })),
      );
    }

    case 'search_products': {
      harvest.searched = true;
      const query = typeof args.query === 'string' ? args.query : '';

      // "food", "clothes": a kind of thing, not an item. Who sells it, not a search for
      // a product called "food" that ends in "I couldn't find exactly what you asked for".
      const broad = broadKindOf(query);
      if (broad)
        return browseKind(
          broad,
          query,
          { ...context, areaId: areaId ?? null },
          harvest,
        );

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
        // "I'm hungry" a message ago says "ofada" is food.
        said: context.buyerText,
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
      // The kind of store: as the model named it, else from what the buyer said.
      // Matched against vendors' own categories however they typed them — "food",
      // "Barbecue, food" and "Restaurant" are all food.
      const kinds = category
        ? standardCategoriesOf(category)
        : !text
          ? categoriesFor(context.buyerText)
          : [];
      const typed =
        kinds.length > 0
          ? await vendorCategoriesFor(context.catalog, kinds, areaId)
          : [];

      let vendors =
        kinds.length > 0 && typed.length === 0
          ? [] // Nothing of that kind serves the area.
          : await context.catalog.searchVendors({
              text,
              category: kinds.length > 0 ? undefined : category,
              categories: typed.length > 0 ? typed : undefined,
              areaId,
            });

      // A name that matched nobody: stores of the kind the words point at, if any.
      if (vendors.length === 0 && text) {
        const named = categoriesFor(text);
        const namedTyped =
          named.length > 0
            ? await vendorCategoriesFor(context.catalog, named, areaId)
            : [];
        if (namedTyped.length > 0) {
          vendors = await context.catalog.searchVendors({
            categories: namedTyped,
            areaId,
          });
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
              ...openingForModel(vendor.isOpen, vendor.opensAt),
              deliversTo: vendor.areas.map((area) => area.name),
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

/** How a buyer says a kind, for the notes: "food", "fashion". */
function kindWord(category: string | null): string {
  return category ? spokenKind(category) : 'similar';
}

/**
 * A kind of thing asked for broadly — "food", "clothes". The vendors that sell it in the
 * buyer's area, shown as a shop assistant would: here's who sells it, what do you fancy?
 * Never a failed search. Without an area there is nothing to show yet: ask for it.
 */
async function browseKind(
  kind: string,
  query: string,
  context: ToolContext,
  harvest: ToolHarvest,
): Promise<string> {
  const said = spokenKind(kind);
  const examples = examplesOf(kind);
  if (!context.areaId) {
    return JSON.stringify({
      broadRequest: true,
      note:
        `"${sanitizeUntrusted(query, 80)}" is a kind of thing, not a particular ` +
        `item, and their area is not known yet. Do not search again. Say we have ` +
        `vendors selling ${said}, and ask what they would like — ${examples}, say — ` +
        'and which area they are in. One short, friendly message.',
    });
  }

  const typed = await vendorCategoriesFor(
    context.catalog,
    [kind],
    context.areaId,
  );
  const vendors =
    typed.length > 0
      ? await context.catalog.searchVendors({
          categories: typed,
          areaId: context.areaId,
        })
      : [];
  harvest.vendors.push(...vendors);

  if (vendors.length === 0) {
    return JSON.stringify({
      broadRequest: true,
      note:
        `No vendors selling ${said} serve their area yet. Say so kindly, and offer ` +
        'to look in another area they name.',
    });
  }
  return JSON.stringify({
    broadRequest: true,
    note:
      `They asked for ${said} in general, not a particular item. These vendors sell ` +
      `${said} in their area. Say something like "Here are vendors selling ${said} ` +
      `near you", then ask what they are in the mood for — ${examples}, say. This ` +
      'is not a failed search: never say you could not find anything. Shown as cards.',
    vendors: vendors.map((vendor) => ({
      id: vendor.id,
      name: sanitizeUntrusted(vendor.name, 80),
      category: sanitizeUntrusted(vendor.category, 60),
      ...openingForModel(vendor.isOpen, vendor.opensAt),
      deliversTo: vendor.areas.map((area) => area.name),
    })),
  });
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
          found.kind === 'similar'
            ? `Nothing is listed as "${asked}" itself. These items share some of its ` +
              `words. Say naturally that you don't see "${asked}" itself, then offer ` +
              'these as close options. Never present one as what they asked for. They ' +
              'are shown as cards.'
            : `No item is listed as "${asked}" by name. These are other ` +
              `${kindWord(found.category)} items near them. Say you don't see ` +
              `"${asked}" listed by name, but here are some ${kindWord(found.category)} ` +
              'options near them that might suit — never present one as what they ' +
              'asked for, and do not apologise at length. Then ask if they want ' +
              'something in particular. They are shown as cards.',
        alternatives: found.products.map(forModel),
      });
    case 'vendors':
      return JSON.stringify({
        exactMatch: false,
        note:
          `No item is listed as "${asked}" by name, but these vendors sell ` +
          `${kindWord(found.category)} near them and may well have it. Say exactly ` +
          'that, and suggest they tap a vendor to see everything they sell. They are ' +
          'shown as cards.',
        vendors: found.vendors.map((vendor) => ({
          id: vendor.id,
          name: sanitizeUntrusted(vendor.name, 80),
          category: sanitizeUntrusted(vendor.category, 60),
          ...openingForModel(vendor.isOpen, vendor.opensAt),
          deliversTo: vendor.areas.map((area) => area.name),
        })),
      });
    case 'ask':
      return JSON.stringify({
        exactMatch: false,
        note:
          `Nothing matches "${asked}", and it is not clear what kind of thing it is. ` +
          'Say you could not find it, and ask what kind of thing they want — ' +
          `${kindsList()} — so you can show who has that near them. Do not ` +
          'suggest vendors of another kind.',
      });
    case 'none':
      return found.category
        ? `Nothing matching that, and no ${found.category} vendors serve the area. Say so; do not suggest vendors of another kind.`
        : 'Nothing available matching that, and nothing similar nearby.';
  }
}

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
    ...(product.vendorIsOpen
      ? {}
      : {
          vendorOpen: false,
          vendorOpens: opensInWords(product.vendorOpensAt),
        }),
  };
}

/**
 * Whether a vendor takes orders now and, if not, when they do — in words, since the
 * model cannot be trusted to turn a timestamp into Lagos time.
 */
function openingForModel(isOpen: boolean, opensAt: string | null) {
  return isOpen ? { isOpen } : { isOpen, opens: opensInWords(opensAt) };
}

function opensInWords(opensAt: string | null): string {
  return opensAt
    ? describeOpening(new Date(opensAt), new Date())
    : 'not taking orders for now';
}
