import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { LocationsService } from './locations.service';
import { State } from './entities/state.entity';
import { Area } from './entities/area.entity';
import { UnmappedVendorArea } from './entities/unmapped-vendor-area.entity';

type MockRepo = {
  find: jest.Mock;
  findOne: jest.Mock;
  count: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  remove: jest.Mock;
  query: jest.Mock;
  createQueryBuilder: jest.Mock;
};

const makeRepo = (): MockRepo => ({
  find: jest.fn(),
  findOne: jest.fn(),
  count: jest.fn(),
  create: jest.fn((input: unknown) => input),
  save: jest.fn((input: unknown) => Promise.resolve(input)),
  remove: jest.fn(),
  query: jest.fn(),
  createQueryBuilder: jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
  })),
});

describe('LocationsService', () => {
  let service: LocationsService;
  let states: MockRepo;
  let areas: MockRepo;
  let unmapped: MockRepo;

  beforeEach(async () => {
    states = makeRepo();
    areas = makeRepo();
    unmapped = makeRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationsService,
        { provide: getRepositoryToken(State), useValue: states },
        { provide: getRepositoryToken(Area), useValue: areas },
        { provide: getRepositoryToken(UnmappedVendorArea), useValue: unmapped },
      ],
    }).compile();

    service = module.get<LocationsService>(LocationsService);
  });

  describe('states', () => {
    it('lists only active states by default', async () => {
      states.find.mockResolvedValue([]);
      await service.listStates();
      expect(states.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } }),
      );
    });

    it('includes deactivated states when asked', async () => {
      states.find.mockResolvedValue([]);
      await service.listStates(true);
      expect(states.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });

    it('rejects a duplicate name regardless of casing', async () => {
      states.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: 's1', name: 'Lagos' }),
      });

      await expect(service.createState({ name: 'lagos' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('normalises the code to upper case', async () => {
      await service.createState({ name: 'Oyo', code: 'oy' });
      expect(states.save).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'OY' }),
      );
    });

    it('refuses to hard delete a state that still has areas', async () => {
      states.findOne.mockResolvedValue({ id: 's1', name: 'Lagos' });
      areas.count.mockResolvedValue(37);

      await expect(service.deleteState('s1')).rejects.toThrow(
        ConflictException,
      );
      expect(states.remove).not.toHaveBeenCalled();
    });

    it('hard deletes a state with no areas', async () => {
      states.findOne.mockResolvedValue({ id: 's1', name: 'Empty' });
      areas.count.mockResolvedValue(0);

      await expect(service.deleteState('s1')).resolves.toEqual({
        message: 'State "Empty" deleted',
      });
      expect(states.remove).toHaveBeenCalled();
    });
  });

  describe('areas', () => {
    it('refuses to hard delete an area vendors serve, and says how many', async () => {
      areas.findOne.mockResolvedValue({ id: 'a1', name: 'Yaba' });
      areas.query.mockResolvedValue([{ count: 12 }]);

      await expect(service.deleteArea('a1')).rejects.toThrow(
        /12 vendor\(s\) serve it/,
      );
      expect(areas.remove).not.toHaveBeenCalled();
    });

    it('hard deletes an area nobody serves', async () => {
      areas.findOne.mockResolvedValue({ id: 'a1', name: 'Nowhere' });
      areas.query.mockResolvedValue([{ count: 0 }]);

      await expect(service.deleteArea('a1')).resolves.toEqual({
        message: 'Area "Nowhere" deleted',
      });
      expect(areas.remove).toHaveBeenCalled();
    });

    it('deactivating leaves the row intact', async () => {
      areas.findOne.mockResolvedValue({
        id: 'a1',
        name: 'Yaba',
        isActive: true,
      });

      const result = await service.setAreaActive('a1', false);

      expect(result.isActive).toBe(false);
      expect(areas.remove).not.toHaveBeenCalled();
    });

    it('404s for an unknown area', async () => {
      areas.findOne.mockResolvedValue(null);
      await expect(service.getArea('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findActiveAreasByIds', () => {
    it('returns an empty list without querying when given nothing', async () => {
      await expect(service.findActiveAreasByIds([])).resolves.toEqual([]);
      expect(areas.find).not.toHaveBeenCalled();
    });

    it('rejects ids that do not resolve to an active area', async () => {
      areas.find.mockResolvedValue([{ id: 'a1' }]);

      await expect(
        service.findActiveAreasByIds(['a1', 'a2-inactive']),
      ).rejects.toThrow(BadRequestException);
    });

    it('names the offending ids so the caller can fix them', async () => {
      areas.find.mockResolvedValue([{ id: 'a1' }]);

      await expect(
        service.findActiveAreasByIds(['a1', 'a2-inactive']),
      ).rejects.toThrow(/a2-inactive/);
    });

    it('de-duplicates before comparing counts', async () => {
      areas.find.mockResolvedValue([{ id: 'a1' }]);

      await expect(
        service.findActiveAreasByIds(['a1', 'a1']),
      ).resolves.toHaveLength(1);
    });
  });

  describe('backfill report', () => {
    it('hides resolved entries by default', async () => {
      unmapped.find.mockResolvedValue([]);
      await service.listUnmappedAreas();
      expect(unmapped.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { resolved: false } }),
      );
    });

    it('marks an entry resolved rather than deleting it', async () => {
      unmapped.findOne.mockResolvedValue({ id: 'u1', resolved: false });

      await service.resolveUnmapped('u1');

      expect(unmapped.save).toHaveBeenCalledWith(
        expect.objectContaining({ resolved: true }),
      );
      expect(unmapped.remove).not.toHaveBeenCalled();
    });
  });
});
