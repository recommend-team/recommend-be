import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DiscoveryService } from './discovery.service';
import { CATALOG_PORT } from '../../ports/catalog.port';
import { LOCATION_PORT } from '../../ports/location.port';

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
  let locations: { searchAreas: jest.Mock };

  beforeEach(async () => {
    catalog = {
      searchProducts: jest.fn().mockResolvedValue([]),
      searchVendors: jest.fn().mockResolvedValue([]),
    };
    locations = { searchAreas: jest.fn().mockResolvedValue([]) };

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
      ],
    }).compile();

    service = module.get<DiscoveryService>(DiscoveryService);
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
