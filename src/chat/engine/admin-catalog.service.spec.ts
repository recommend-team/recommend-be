import { Test, TestingModule } from '@nestjs/testing';
import { AdminCatalogService } from './admin-catalog.service';
import { ConversationService } from '../conversation/conversation.service';
import { CATALOG_PORT } from '../ports/catalog.port';
import { LOCATION_PORT } from '../ports/location.port';
import type { Conversation } from '../conversation/entities/conversation.entity';

const IKEJA = 'area-ikeja';
const LEKKI = 'area-lekki';

const area = (id: string, name: string) => ({ id, name, stateName: 'Lagos' });

const conversationWith = (over: Partial<Conversation> = {}): Conversation =>
  ({
    id: 'c1',
    areaId: IKEJA,
    context: {},
    ...over,
  }) as unknown as Conversation;

describe('AdminCatalogService', () => {
  let service: AdminCatalogService;
  let catalog: { searchVendors: jest.Mock; searchProducts: jest.Mock };
  let locations: {
    listAreas: jest.Mock;
    searchAreas: jest.Mock;
    getAreaById: jest.Mock;
  };
  let conversations: { findById: jest.Mock; setArea: jest.Mock };

  beforeEach(async () => {
    catalog = {
      searchVendors: jest.fn().mockResolvedValue([]),
      searchProducts: jest.fn().mockResolvedValue([]),
    };
    locations = {
      listAreas: jest.fn().mockResolvedValue([area(IKEJA, 'Ikeja')]),
      searchAreas: jest.fn().mockResolvedValue([area(LEKKI, 'Lekki')]),
      getAreaById: jest.fn().mockResolvedValue(area(IKEJA, 'Ikeja')),
    };
    conversations = {
      findById: jest.fn().mockResolvedValue(conversationWith()),
      setArea: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminCatalogService,
        { provide: CATALOG_PORT, useValue: catalog },
        { provide: LOCATION_PORT, useValue: locations },
        { provide: ConversationService, useValue: conversations },
      ],
    }).compile();

    service = module.get(AdminCatalogService);
  });

  describe('the area the admin starts from', () => {
    it('preselects what the conversation already knows', async () => {
      const context = await service.context('c1');

      expect(context.areaId).toBe(IKEJA);
      expect(context.area?.name).toBe('Ikeja');
      expect(locations.listAreas).toHaveBeenCalled();
    });

    it('asks for nothing preselected when nobody has said where the buyer is', async () => {
      conversations.findById.mockResolvedValue(
        conversationWith({ areaId: null }),
      );

      const context = await service.context('c1');

      expect(context.areaId).toBeNull();
      expect(context.area).toBeNull();
      expect(locations.getAreaById).not.toHaveBeenCalled();
    });

    it('narrows the list when the admin types', async () => {
      const context = await service.context('c1', ' lekki ');

      expect(locations.searchAreas).toHaveBeenCalledWith('lekki', 20);
      expect(context.areas[0].name).toBe('Lekki');
    });
  });

  describe('remembering the area', () => {
    it('writes it to the conversation, not just the screen', async () => {
      // DiscoveryService reads the same field, so the assistant stops asking.
      locations.getAreaById.mockResolvedValue(area(LEKKI, 'Lekki'));

      const saved = await service.setArea('c1', LEKKI);

      expect(conversations.setArea).toHaveBeenCalledWith('c1', LEKKI);
      expect(saved.name).toBe('Lekki');
    });

    it('refuses an area that does not exist', async () => {
      locations.getAreaById.mockResolvedValue(null);

      await expect(service.setArea('c1', 'nope')).rejects.toThrow(
        /no such area/i,
      );
      expect(conversations.setArea).not.toHaveBeenCalled();
    });
  });

  describe('stores and products', () => {
    it("defaults to the buyer's own area", async () => {
      await service.stores('c1', {});

      expect(catalog.searchVendors).toHaveBeenCalledWith(
        expect.objectContaining({ areaId: IKEJA }),
      );
    });

    it('lets the admin look at another area deliberately', async () => {
      await service.stores('c1', { areaId: LEKKI });

      expect(catalog.searchVendors).toHaveBeenCalledWith(
        expect.objectContaining({ areaId: LEKKI }),
      );
    });

    it('keeps the area filter on a product search by name', async () => {
      // Knowing what you want is not a reason to reach a vendor who cannot deliver it.
      await service.products('c1', { search: 'jollof' });

      expect(catalog.searchProducts).toHaveBeenCalledWith(
        expect.objectContaining({ areaId: IKEJA, text: 'jollof' }),
      );
    });

    it('scopes products to one store when asked', async () => {
      await service.products('c1', { vendorId: 'v1' });

      expect(catalog.searchProducts).toHaveBeenCalledWith(
        expect.objectContaining({ vendorId: 'v1', areaId: IKEJA }),
      );
    });

    it('does not invent an area for a thread that has none', async () => {
      // Everything, rather than nothing: the admin is told to choose an area, not shown
      // an empty shop and left wondering whether the platform is broken.
      conversations.findById.mockResolvedValue(
        conversationWith({ areaId: null }),
      );

      await service.stores('c1', {});

      expect(catalog.searchVendors).toHaveBeenCalledWith(
        expect.objectContaining({ areaId: undefined }),
      );
    });

    it('ignores a blank search rather than filtering on empty text', async () => {
      await service.products('c1', { search: '   ' });

      expect(catalog.searchProducts).toHaveBeenCalledWith(
        expect.objectContaining({ text: undefined }),
      );
    });
  });

  it('says nothing about a conversation that does not exist', async () => {
    conversations.findById.mockResolvedValue(null);

    await expect(service.context('c1')).rejects.toThrow(/not found/i);
  });
});
