import type { ConfigService } from '@nestjs/config';
import { EngineService } from '../engine.service';
import { DiscoveryService } from '../discovery/discovery.service';
import type { ConversationService } from '../../conversation/conversation.service';
import type { ChannelRegistry } from '../../transport/channel.registry';
import type { CheckoutFlow } from '../flows/checkout.flow';
import type { HandoverService } from '../handover.service';
import type {
  Conversation,
  ConversationContext,
} from '../../conversation/entities/conversation.entity';
import type {
  ChatMessage,
  MessagePayload,
} from '../../conversation/entities/message.entity';
import {
  ChatChannel,
  ConversationState,
  MessageAuthor,
} from '../../enums/chat.enums';
import type {
  CatalogPort,
  ProductSummary,
  VendorSummary,
} from '../../ports/catalog.port';
import type { AreaSummary, LocationPort } from '../../ports/location.port';
import type {
  BuyerOrderSummary,
  OrderingPort,
} from '../../ports/ordering.port';

/**
 * The real engine and discovery code, with the database replaced by a small, fixed
 * Recommend: two areas with vendors, one without, a handful of dishes, one order on its
 * way. Used by the buyer-questions spec (no model) and `yarn chat:eval` (the real model).
 */

export const DELIVERY_FEE = 1500;

export const AREAS: AreaSummary[] = [
  { id: 'area-yaba', name: 'Yaba', stateName: 'Lagos' },
  { id: 'area-ikeja', name: 'Ikeja', stateName: 'Lagos' },
  // Exists, but no vendor serves it.
  { id: 'area-ajah', name: 'Ajah', stateName: 'Lagos' },
];
const SERVED = new Set(['area-yaba', 'area-ikeja']);

const VENDORS: VendorSummary[] = [
  {
    id: 'v-mama',
    name: "Mama's Kitchen",
    slug: 'mamas-kitchen',
    category: 'Food',
    areas: [{ id: 'area-yaba', name: 'Yaba' }],
    isOpen: true,
    logoUrl: null,
  },
  {
    id: 'v-grill',
    name: 'Ikeja Grill House',
    slug: 'ikeja-grill-house',
    category: 'Food',
    areas: [{ id: 'area-ikeja', name: 'Ikeja' }],
    isOpen: true,
    logoUrl: null,
  },
];

const product = (
  id: string,
  name: string,
  price: number,
  vendor: VendorSummary,
): ProductSummary => ({
  id,
  name,
  description: null,
  price,
  imageUrl: null,
  vendorId: vendor.id,
  vendorName: vendor.name,
  vendorSlug: vendor.slug,
  isAddOn: false,
});

export const PRODUCTS: ProductSummary[] = [
  product('p-jollof', 'Jollof Rice and Chicken', 3000, VENDORS[0]),
  product('p-fried', 'Fried Rice and Turkey', 3500, VENDORS[0]),
  product('p-amala', 'Amala and Ewedu', 2500, VENDORS[0]),
  product('p-shawarma', 'Chicken Shawarma', 2800, VENDORS[1]),
  product('p-suya', 'Beef Suya', 2000, VENDORS[1]),
];

export const ORDER_ON_ITS_WAY: BuyerOrderSummary = {
  reference: 'REC-TEST1',
  status: 'DISPATCHED',
  createdAt: '2026-10-10T09:00:00.000Z',
  paidAt: '2026-10-10T09:01:00.000Z',
  fulfillmentType: 'DELIVERY',
  deliveryAddress: '12 Herbert Macaulay Way, Yaba',
  goodsTotal: 6000,
  deliveryFee: DELIVERY_FEE,
  totalAmount: 7500,
  canComplete: true,
  handoverCode: '4821',
  rider: { name: 'Tunde Bakare', phone: '+2348000000000' },
  vendors: [
    {
      vendorName: "Mama's Kitchen",
      pickupAddress: null,
      status: 'DISPATCHED',
      items: [
        { name: 'Jollof Rice and Chicken', quantity: 2, lineTotal: 6000 },
      ],
    },
  ],
};

/** Every amount a reply may legitimately contain. */
export const KNOWN_AMOUNTS = [
  DELIVERY_FEE,
  ...PRODUCTS.map((item) => item.price),
  ORDER_ON_ITS_WAY.goodsTotal,
  ORDER_ON_ITS_WAY.totalAmount,
];

const words = (text: string | undefined) =>
  (text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);

const catalog: CatalogPort = {
  listCategories: () => Promise.resolve([{ name: 'Food', storeCount: 2 }]),
  getVendorById: (id) =>
    Promise.resolve(VENDORS.find((vendor) => vendor.id === id) ?? null),
  getProductById: (id) =>
    Promise.resolve(PRODUCTS.find((item) => item.id === id) ?? null),
  listAddOns: () => Promise.resolve([]),
  searchProducts: (query) => {
    const wanted = words(query.text);
    return Promise.resolve(
      PRODUCTS.filter((item) => {
        const vendor = VENDORS.find((v) => v.id === item.vendorId)!;
        if (query.vendorId && item.vendorId !== query.vendorId) return false;
        if (query.areaId && !vendor.areas.some((a) => a.id === query.areaId)) {
          return false;
        }
        if (query.categories?.length) return true;
        const name = item.name.toLowerCase();
        return wanted.every((word) => name.includes(word));
      }).slice(0, query.limit ?? 8),
    );
  },
  searchVendors: (query) => {
    const wanted = words(query.text);
    return Promise.resolve(
      VENDORS.filter((vendor) => {
        if (query.areaId && !vendor.areas.some((a) => a.id === query.areaId)) {
          return false;
        }
        const name = vendor.name.toLowerCase();
        return wanted.every((word) => name.includes(word));
      }),
    );
  },
};

const locations: LocationPort = {
  searchAreas: (text) => {
    const said = words(text);
    return Promise.resolve(
      AREAS.filter((area) => said.includes(area.name.toLowerCase())),
    );
  },
  listAreas: () => Promise.resolve(AREAS),
  listServedAreas: () =>
    Promise.resolve(AREAS.filter((area) => SERVED.has(area.id))),
  getAreaById: (id) =>
    Promise.resolve(AREAS.find((area) => area.id === id) ?? null),
};

const ordering = {
  listOrders: (references: string[]) =>
    Promise.resolve(
      references.includes(ORDER_ON_ITS_WAY.reference) ? [ORDER_ON_ITS_WAY] : [],
    ),
  deliveryFeeFor: (type: 'PICKUP' | 'DELIVERY') =>
    type === 'DELIVERY' ? DELIVERY_FEE : 0,
  placeCheckout: () => Promise.reject(new Error('not in this harness')),
  completeOrder: () => Promise.resolve(),
} as OrderingPort;

export interface Reply {
  text: string;
  payload?: MessagePayload;
}

export interface Turn {
  buyer: string;
  replies: Reply[];
}

export interface Run {
  turns: Turn[];
  /** Every handover the engine asked for, with its reason. */
  handovers: string[];
}

export interface BuyerSetup {
  /** Seeds the conversation, e.g. a returning buyer with an order. */
  context?: ConversationContext;
  areaId?: string | null;
}

/**
 * Plays the buyer's messages through the engine, one at a time, as the gateway would.
 * Without `apiKey` the deployment runs on keyword search, exactly as production does
 * when no key is configured.
 */
export async function converse(
  messages: string[],
  options: { apiKey?: string; model?: string; setup?: BuyerSetup } = {},
): Promise<Run> {
  const settings: Record<string, unknown> = {
    'openai.apiKey': options.apiKey,
    'openai.model': options.model ?? 'gpt-4o-mini',
    'chat.assistantName': 'James',
    'chat.maxHistoryMessages': 20,
    'chat.maxToolRounds': 3,
  };
  const config = {
    get: (key: string) => settings[key],
  } as unknown as ConfigService;

  const conversation = {
    id: 'conversation-1',
    channel: ChatChannel.PWA,
    channelAddress: 'session-1',
    state: ConversationState.DISCOVERY,
    areaId: options.setup?.areaId ?? null,
    accountId: null,
    context: { ...options.setup?.context },
    needsAttentionAt: null,
    attentionReason: null,
    heldByAdminId: null,
    handoverRequestedAt: null,
  } as unknown as Conversation;

  const history: ChatMessage[] = [];
  let sequence = 0;
  const record = (
    author: MessageAuthor,
    text: string,
    payload?: MessagePayload,
  ) => {
    const message = {
      id: `m${++sequence}`,
      conversationId: conversation.id,
      author,
      text,
      payload: payload ?? null,
      createdAt: new Date(Date.now() + sequence),
    } as unknown as ChatMessage;
    history.push(message);
    return message;
  };

  const conversations = {
    recordInbound: ({ text }: { text: string }) =>
      Promise.resolve(record(MessageAuthor.BUYER, text)),
    recordOutbound: ({
      text,
      payload,
    }: {
      text: string;
      payload?: MessagePayload;
    }) => Promise.resolve(record(MessageAuthor.ASSISTANT, text, payload)),
    getHistory: (_id: string, { limit }: { limit: number }) =>
      Promise.resolve(history.slice(-limit)),
    mergeContext: (_id: string, patch: ConversationContext) => {
      conversation.context = { ...conversation.context, ...patch };
      return Promise.resolve(conversation);
    },
    setArea: (_id: string, areaId: string) => {
      conversation.areaId = areaId;
      return Promise.resolve();
    },
    flagForAttention: () => Promise.resolve(),
    findById: () => Promise.resolve(conversation),
  } as unknown as ConversationService;

  const handovers: string[] = [];
  const handover = {
    shouldStaySilent: () => Promise.resolve(false),
    announceBuyerWaiting: () => undefined,
    requestHandover: (target: Conversation, reason: string) => {
      handovers.push(reason);
      target.handoverRequestedAt = new Date();
      return Promise.resolve(true);
    },
  } as unknown as HandoverService;

  const discovery = new DiscoveryService(config, catalog, locations, ordering);
  const engine = new EngineService(
    conversations,
    { send: () => Promise.resolve(null) } as unknown as ChannelRegistry,
    discovery,
    { handle: () => Promise.resolve([]) } as unknown as CheckoutFlow,
    handover,
    config,
    ordering,
  );

  const turns: Turn[] = [];
  for (const text of messages) {
    const replies = await engine.handleInbound({ conversation, text });
    turns.push({
      buyer: text,
      replies: replies.map((reply) => ({
        text: reply.text,
        payload: reply.payload,
      })),
    });
  }

  return { turns, handovers };
}
