import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DiscoveryService } from './discovery.service';
import { CATALOG_PORT } from '../../ports/catalog.port';
import { LOCATION_PORT } from '../../ports/location.port';
import { ORDERING_PORT } from '../../ports/ordering.port';

const YABA = { id: 'area-yaba', name: 'Yaba', stateName: 'Lagos' };

const mockCreate = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('openai', () => ({
  __esModule: true,
  // Read lazily: jest.mock is hoisted above mockCreate's declaration.
  default: jest.fn(() => ({
    chat: {
      completions: { create: (...args: unknown[]) => mockCreate(...args) },
    },
  })),
}));

const product = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'p1',
  name: 'Jollof Rice',
  description: null,
  price: 3000,
  imageUrl: null,
  vendorId: 'v1',
  vendorName: "Mama's Kitchen",
  ...over,
});

/**
 * These cover the no-API-key path, which is a supported mode rather than a
 * degraded one: without a key the platform still returns real vendors and real
 * dishes from the database.
 */
describe('DiscoveryService (keyword fallback)', () => {
  let service: DiscoveryService;
  let catalog: { searchProducts: jest.Mock; searchVendors: jest.Mock };
  let locations: { searchAreas: jest.Mock; listServedAreas: jest.Mock };
  let ordering: { listOrders: jest.Mock; deliveryFeeFor: jest.Mock };

  beforeEach(async () => {
    catalog = {
      searchProducts: jest.fn().mockResolvedValue([]),
      searchVendors: jest.fn().mockResolvedValue([]),
    };
    locations = {
      searchAreas: jest.fn().mockResolvedValue([]),
      listServedAreas: jest.fn().mockResolvedValue([YABA]),
    };
    ordering = {
      listOrders: jest.fn().mockResolvedValue([]),
      deliveryFeeFor: jest.fn().mockReturnValue(1500),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscoveryService,
        {
          provide: ConfigService,
          // No openai.apiKey — forces the fallback path.
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
        { provide: CATALOG_PORT, useValue: catalog },
        { provide: LOCATION_PORT, useValue: locations },
        { provide: ORDERING_PORT, useValue: ordering },
      ],
    }).compile();

    service = module.get<DiscoveryService>(DiscoveryService);
  });

  describe('questions about Recommend', () => {
    const ask = (text: string, orderReferences: string[] = []) =>
      service.discover({ text, areaId: null, history: [], orderReferences });

    it('answers the delivery fee from configuration, past the price guard', async () => {
      ordering.deliveryFeeFor.mockReturnValue(2000);

      const result = await ask('how much is delivery?');

      expect(result.messages[0].text).toContain('₦2,000');
      expect(catalog.searchProducts).not.toHaveBeenCalled();
      // Answered, not a search that came back empty.
      expect(result.foundNothing).toBe(false);
    });

    it('says yes to an area we cover, and remembers it', async () => {
      locations.searchAreas.mockResolvedValue([YABA]);

      const result = await ask('do you deliver to Yaba?');

      expect(result.messages[0].text).toBe(
        'Yes — we have vendors in Yaba. What would you like?',
      );
      expect(result.resolvedAreaId).toBe('area-yaba');
    });

    it('is honest about an area with no vendors, and names the ones we cover', async () => {
      locations.searchAreas.mockResolvedValue([
        { id: 'area-ajah', name: 'Ajah', stateName: 'Lagos' },
      ]);

      const result = await ask('do you deliver to Ajah');

      expect(result.messages[0].text).toBe(
        "We don't have vendors in Ajah yet. Right now we cover Yaba (Lagos).",
      );
    });

    it('answers "where is my order?" from their own orders', async () => {
      ordering.listOrders.mockResolvedValue([
        {
          reference: 'REC-1A2B',
          status: 'READY',
          fulfillmentType: 'PICKUP',
          handoverCode: '4821',
          goodsTotal: 4100,
          deliveryFee: 0,
          totalAmount: 4100,
          rider: null,
          vendors: [],
        },
      ]);

      const result = await ask('where is my order', ['REC-1A2B']);

      expect(ordering.listOrders).toHaveBeenCalledWith(['REC-1A2B']);
      expect(result.messages[0].text).toContain(
        'REC-1A2B, is ready to collect',
      );
    });

    it('hands a refund question to the engine to offer the team', async () => {
      const result = await ask('I want a refund for my order');

      expect(result.handover).toMatch(/refund/);
      expect(result.buyerAskedForPerson).toBe(false);
    });

    it('reads the covered areas once a minute, not on every reply', async () => {
      await ask('how much is delivery?');
      await ask('which areas do you cover?');

      expect(locations.listServedAreas).toHaveBeenCalledTimes(1);
    });
  });

  it('searches on the dish, with filler words stripped', async () => {
    await service.discover({
      text: 'I want some jollof',
      areaId: null,
      history: [],
    });

    expect(catalog.searchProducts).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'jollof' }),
    );
  });

  it('returns matching dishes as a product_list payload', async () => {
    catalog.searchProducts.mockResolvedValue([product()]);

    const result = await service.discover({
      text: 'jollof',
      areaId: null,
      history: [],
    });

    expect(result.messages[0].payload?.kind).toBe('product_list');
    expect(result.usedFallback).toBe(true);
  });

  it('groups dishes under the restaurant that sells them', async () => {
    catalog.searchProducts.mockResolvedValue([
      product({ id: 'p1', vendorId: 'v1' }),
      product({ id: 'p2', vendorId: 'v1', name: 'Fried Rice' }),
      product({ id: 'p3', vendorId: 'v2', vendorName: 'Buka Express' }),
    ]);

    const result = await service.discover({
      text: 'rice',
      areaId: null,
      history: [],
    });

    const data = result.messages[0].payload?.data as {
      vendors: { vendorId: string; items: unknown[] }[];
    };
    expect(data.vendors).toHaveLength(2);
    expect(data.vendors[0].items).toHaveLength(2);
  });

  it('resolves an unambiguous area and reports it back for storage', async () => {
    locations.searchAreas.mockResolvedValue([
      { id: 'area-yaba', name: 'Yaba', stateName: 'Lagos' },
    ]);

    const result = await service.discover({
      text: 'jollof in yaba',
      areaId: null,
      history: [],
    });

    expect(result.resolvedAreaId).toBe('area-yaba');
    expect(catalog.searchProducts).toHaveBeenCalledWith(
      expect.objectContaining({ areaId: 'area-yaba' }),
    );
  });

  it('searches the dish, not the place the buyer named', async () => {
    // Every word must match a dish, so "jollof in Lekki" found nothing: no dish is
    // called Lekki. Two areas match "Lekki", so neither is assumed — but both words go.
    locations.searchAreas.mockResolvedValue([
      { id: 'a1', name: 'Lekki', stateName: 'Lagos' },
      { id: 'a2', name: 'Ibeju-Lekki', stateName: 'Lagos' },
    ]);

    await service.discover({
      text: 'jollof in Lekki',
      areaId: null,
      history: [],
    });

    expect(catalog.searchProducts).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'jollof' }),
    );
  });

  it('does not guess when the location is ambiguous', async () => {
    locations.searchAreas.mockResolvedValue([
      { id: 'a1', name: 'Ikeja', stateName: 'Lagos' },
      { id: 'a2', name: 'Ikeja GRA', stateName: 'Lagos' },
    ]);

    const result = await service.discover({
      text: 'ikeja',
      areaId: null,
      history: [],
    });

    expect(result.resolvedAreaId).toBeNull();
  });

  it('keeps the known area when the message names no area', async () => {
    const result = await service.discover({
      text: 'jollof',
      areaId: 'area-known',
      history: [],
    });

    expect(catalog.searchProducts).toHaveBeenCalledWith(
      expect.objectContaining({ areaId: 'area-known' }),
    );
    // Nothing changed, so nothing to write back to the conversation.
    expect(result.resolvedAreaId).toBeNull();
  });

  it('follows the buyer when they name a different area', async () => {
    // The bug this replaces: "jollof rice in Egbeda" answered with Ikeja vendors,
    // because a remembered area outranked the one the buyer had just said out loud.
    locations.searchAreas.mockResolvedValue([
      { id: 'area-egbeda', name: 'Egbeda', stateName: 'Lagos' },
    ]);

    const result = await service.discover({
      text: 'I want jollof rice in Egbeda',
      areaId: 'area-ikeja',
      history: [],
    });

    expect(catalog.searchProducts).toHaveBeenCalledWith(
      expect.objectContaining({ areaId: 'area-egbeda' }),
    );
    // Written back, so the next turn searches Egbeda too.
    expect(result.resolvedAreaId).toBe('area-egbeda');
  });

  it('falls back to nearby stores when no dish matches', async () => {
    catalog.searchProducts.mockResolvedValue([]);
    catalog.searchVendors.mockResolvedValue([
      {
        id: 'v1',
        name: "Mama's Kitchen",
        slug: 'mamas',
        category: 'Food',
        areas: [],
        isOpen: true,
        logoUrl: null,
      },
    ]);

    const result = await service.discover({
      text: 'sushi',
      areaId: null,
      history: [],
    });

    expect(result.messages[0].payload?.kind).toBe('vendor_list');
  });

  it('says so plainly when nothing matches at all', async () => {
    const result = await service.discover({
      text: 'caviar',
      areaId: null,
      history: [],
    });

    expect(result.messages[0].payload).toBeUndefined();
    expect(result.messages[0].text).toContain('could not find');
  });

  it('never states a price in its own prose', async () => {
    catalog.searchProducts.mockResolvedValue([product()]);

    const result = await service.discover({
      text: 'jollof',
      areaId: null,
      history: [],
    });

    expect(result.messages[0].text).not.toMatch(/\d{3,}/);
  });
});

/**
 * The model path, with the OpenAI client replaced. What matters here is not what the model
 * says but what the service does with it: a request for a teammate, and an outage.
 */
describe('DiscoveryService (model)', () => {
  let service: DiscoveryService;
  const modelOrdering = {
    listOrders: jest.fn(),
    deliveryFeeFor: jest.fn(),
  };

  beforeEach(async () => {
    mockCreate.mockReset();
    modelOrdering.listOrders.mockReset().mockResolvedValue([]);
    modelOrdering.deliveryFeeFor.mockReset().mockReturnValue(1500);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscoveryService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'openai.apiKey' ? 'sk-test' : undefined,
          },
        },
        {
          provide: CATALOG_PORT,
          useValue: {
            searchProducts: jest.fn().mockResolvedValue([]),
            searchVendors: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: LOCATION_PORT,
          useValue: {
            searchAreas: jest.fn().mockResolvedValue([]),
            listServedAreas: jest.fn().mockResolvedValue([YABA]),
          },
        },
        { provide: ORDERING_PORT, useValue: modelOrdering },
      ],
    }).compile();

    service = module.get(DiscoveryService);
  });

  const replies = (content: string) => ({
    choices: [{ message: { role: 'assistant', content } }],
  });

  /** Every system message the model was given on its first call. */
  const systemMessages = (): string[] => {
    const [request] = mockCreate.mock.calls[0] as [
      { messages: { role: string; content: string }[] },
    ];
    return request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content);
  };

  it('gives the model what Recommend is, with the live fee and areas', async () => {
    mockCreate.mockResolvedValueOnce(replies('Delivery is a flat ₦1,500.'));

    const result = await service.discover({
      text: 'how much is delivery',
      areaId: null,
      history: [],
    });

    const knowledge = systemMessages().find((content) =>
      content.startsWith('WHAT YOU KNOW ABOUT RECOMMEND'),
    );
    expect(knowledge).toContain('flat ₦1,500');
    expect(knowledge).toContain('Yaba (Lagos)');
    // The fee came from the system, so the price guard lets it through.
    expect(result.messages[0].text).toBe('Delivery is a flat ₦1,500.');
  });

  it('still drops a price nobody gave it', async () => {
    mockCreate.mockResolvedValueOnce(replies('Delivery is a flat ₦900.'));

    const result = await service.discover({
      text: 'how much is delivery',
      areaId: null,
      history: [],
    });

    expect(result.messages[0].text).not.toContain('900');
  });

  it('tells the model about the buyer, including their latest order', async () => {
    modelOrdering.listOrders.mockResolvedValueOnce([
      {
        reference: 'REC-9Z',
        status: 'DISPATCHED',
        fulfillmentType: 'DELIVERY',
        rider: { name: 'Tunde Bakare', phone: null },
        vendors: [],
      },
    ]);
    mockCreate.mockResolvedValueOnce(replies('Hi Ada!'));

    await service.discover({
      text: 'hello',
      areaId: null,
      history: [],
      buyerFirstName: 'Ada',
      lastDeliveryAddress: '12 Herbert Macaulay Way',
      signedIn: true,
      orderReferences: ['REC-9Z'],
    });

    const note = systemMessages().find((content) =>
      content.startsWith('ABOUT THIS BUYER'),
    );
    expect(note).toContain('Ada, who has ordered from us before');
    expect(note).toContain('Last delivery went to: 12 Herbert Macaulay Way');
    expect(note).toContain('Signed in');
    expect(note).toContain('Latest order REC-9Z: on its way with Tunde');
  });

  it('still answers when the orders cannot be read', async () => {
    modelOrdering.listOrders.mockRejectedValueOnce(new Error('db down'));
    mockCreate.mockResolvedValueOnce(replies('Hello!'));

    const result = await service.discover({
      text: 'hello',
      areaId: null,
      history: [],
      orderReferences: ['REC-9Z'],
    });

    expect(result.messages[0].text).toBe('Hello!');
  });

  const toolCall = (name: string, args: Record<string, unknown>) => ({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  });

  it('reports a request for a teammate, and stops there', async () => {
    mockCreate.mockResolvedValueOnce(
      toolCall('request_teammate', { reason: 'Asking where order REC-1 is' }),
    );

    const result = await service.discover({
      text: 'where is my order REC-1',
      areaId: null,
      history: [],
    });

    expect(result.handover).toBe('Asking where order REC-1 is');
    // No second round: whatever the model would say next is not sent.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.modelFailed).toBe(false);
  });

  it('says the model failed when it did, as distinct from having no key', async () => {
    mockCreate.mockRejectedValueOnce(new Error('503 from OpenAI'));

    const result = await service.discover({
      text: 'jollof',
      areaId: null,
      history: [],
    });

    expect(result.usedFallback).toBe(true);
    expect(result.modelFailed).toBe(true);
    expect(result.handover).toBeNull();
  });

  it('does not count small talk as a search that found nothing', async () => {
    // "who are you?" searches for nothing, so it finds nothing — that used to count as
    // struggling, and two such turns handed the buyer to an admin.
    mockCreate.mockResolvedValueOnce(
      replies("I'm James! I help you find things from vendors near you."),
    );

    const result = await service.discover({
      text: 'who are you?',
      areaId: null,
      history: [],
    });

    expect(result.foundNothing).toBe(false);
    expect(result.handover).toBeNull();
    expect(result.messages[0].text).toContain("I'm James");
  });

  it('gives the model its persona by name, at a conversational temperature', async () => {
    mockCreate.mockResolvedValueOnce(replies('Hey! How far?'));

    await service.discover({ text: 'how far', areaId: null, history: [] });

    const [request] = mockCreate.mock.calls[0] as [
      { temperature: number; messages: { role: string; content: string }[] },
    ];
    expect(request.messages[0].content).toContain('You are James');
    expect(request.temperature).toBe(0.6);
  });
});
