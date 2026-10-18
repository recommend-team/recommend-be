import { ConflictException, BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { AreaNamesService } from './area-names.service';
import type { State } from './entities/state.entity';
import type { Area } from './entities/area.entity';
import type { AreaAlias } from './entities/area-alias.entity';
import type { UnplacedLocation } from './entities/unplaced-location.entity';
import { PLACES_CHANGED_EVENT } from '../../common/events/places-changed.event';

const LAGOS = { id: 'lagos', name: 'Lagos', isActive: true } as State;
const AJAH = {
  id: 'ajah',
  name: 'Ajah',
  stateId: 'lagos',
  isActive: true,
} as Area;
const LEKKI = {
  id: 'lekki',
  name: 'Lekki',
  stateId: 'lagos',
  isActive: true,
} as Area;

describe('AreaNamesService', () => {
  let aliases: AreaAlias[];
  let unplaced: UnplacedLocation[];
  let emit: jest.Mock;
  let service: AreaNamesService;

  beforeEach(() => {
    aliases = [
      {
        id: 'al1',
        areaId: 'lekki',
        name: 'Chevron',
        normalised: 'chevron',
        area: LEKKI,
      } as AreaAlias,
    ];
    unplaced = [
      {
        id: 'u1',
        text: 'Badore',
        normalised: 'badore',
        timesSeen: 12,
        resolvedAreaId: null,
      } as UnplacedLocation,
    ];
    emit = jest.fn();

    const areas = {
      find: jest.fn().mockResolvedValue([AJAH, LEKKI]),
      findOne: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve([AJAH, LEKKI].find((a) => a.id === where.id) ?? null),
      ),
      query: jest.fn().mockResolvedValue([{ areaId: 'ajah', count: 1 }]),
    };
    const aliasRepo = {
      find: jest.fn(() => Promise.resolve(aliases)),
      findOne: jest.fn(
        ({ where }: { where: { id?: string; normalised?: string } }) =>
          Promise.resolve(
            aliases.find((a) =>
              where.id ? a.id === where.id : a.normalised === where.normalised,
            ) ?? null,
          ),
      ),
      create: jest.fn((row: Partial<AreaAlias>) => row),
      save: jest.fn((row: AreaAlias) => {
        const saved = { ...row, id: `al${aliases.length + 1}` };
        aliases.push(saved);
        return Promise.resolve(saved);
      }),
      remove: jest.fn((row: AreaAlias) => {
        aliases = aliases.filter((a) => a.id !== row.id);
        return Promise.resolve(row);
      }),
    };
    const unplacedRepo = {
      find: jest.fn(() =>
        Promise.resolve(unplaced.filter((u) => u.resolvedAreaId === null)),
      ),
      findOne: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(unplaced.find((u) => u.id === where.id) ?? null),
      ),
      update: jest.fn(
        (
          where: { id?: string; normalised?: string },
          patch: Partial<UnplacedLocation>,
        ) => {
          for (const row of unplaced) {
            if (
              (where.id && row.id === where.id) ||
              (where.normalised && row.normalised === where.normalised)
            ) {
              Object.assign(row, patch);
            }
          }
          return Promise.resolve();
        },
      ),
      remove: jest.fn((row: UnplacedLocation) => {
        unplaced = unplaced.filter((u) => u.id !== row.id);
        return Promise.resolve(row);
      }),
    };

    service = new AreaNamesService(
      {
        find: jest.fn().mockResolvedValue([LAGOS]),
      } as unknown as Repository<State>,
      areas as unknown as Repository<Area>,
      aliasRepo as unknown as Repository<AreaAlias>,
      unplacedRepo as unknown as Repository<UnplacedLocation>,
      { emit } as never,
    );
  });

  it('lists every area with its vendors and other names', async () => {
    const [lagos] = await service.overview();

    expect(lagos.areas).toEqual([
      { id: 'ajah', name: 'Ajah', isActive: true, vendorCount: 1, aliases: [] },
      {
        id: 'lekki',
        name: 'Lekki',
        isActive: true,
        vendorCount: 0,
        aliases: [{ id: 'al1', name: 'Chevron' }],
      },
    ]);
  });

  it('adds "Badore" to Ajah, closes it on the unplaced list, and tells the chat', async () => {
    const alias = await service.addAlias('ajah', '  Badore ');

    expect(alias).toMatchObject({
      areaId: 'ajah',
      name: 'Badore',
      normalised: 'badore',
    });
    expect(unplaced[0].resolvedAreaId).toBe('ajah');
    expect(emit).toHaveBeenCalledWith(PLACES_CHANGED_EVENT);
  });

  it('refuses a name another area already has, saying whose', async () => {
    await expect(service.addAlias('ajah', 'chevron')).rejects.toThrow(
      new ConflictException('"Chevron" is already a name for Lekki'),
    );
  });

  it('refuses an area’s own name as another area’s', async () => {
    // "Lekki" for Ajah would send Lekki buyers to Ajah.
    await expect(service.addAlias('ajah', 'Lekki')).rejects.toThrow(
      new ConflictException('"Lekki" is already the area Lekki'),
    );
  });

  it('refuses a name with no letters in it', async () => {
    await expect(service.addAlias('ajah', '!!')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('places a place buyers typed, as they typed it or written better', async () => {
    const alias = await service.placeUnplaced('u1', 'ajah', 'Badore Road');

    expect(alias).toMatchObject({ areaId: 'ajah', name: 'Badore Road' });
    expect(unplaced[0].resolvedAreaId).toBe('ajah');
    expect(await service.listUnplaced()).toEqual([]);
  });

  it('dismisses a place, and removes a name — the chat told each time names change', async () => {
    await service.dismissUnplaced('u1');
    expect(unplaced).toEqual([]);

    await service.removeAlias('al1');
    expect(aliases).toEqual([]);
    expect(emit).toHaveBeenCalledWith(PLACES_CHANGED_EVENT);
  });
});
