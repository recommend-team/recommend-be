import { LocalLocationAdapter } from './local-location.adapter';
import type { Area } from '../../modules/locations/entities/area.entity';
import type { AreaAlias } from '../../modules/locations/entities/area-alias.entity';
import type { UnplacedLocation } from '../../modules/locations/entities/unplaced-location.entity';
import type { Repository } from 'typeorm';

const LAGOS = { id: 'lagos', name: 'Lagos' };
const area = (id: string, name: string) =>
  ({ id, name, state: LAGOS }) as unknown as Area;
const AREAS = [
  area('ajah', 'Ajah'),
  area('lekki', 'Lekki'),
  area('ibeju', 'Ibeju-Lekki'),
  area('ikeja', 'Ikeja'),
  area('yaba', 'Yaba'),
];
const alias = (areaId: string, name: string, normalised: string) =>
  ({ areaId, name, normalised }) as AreaAlias;
const ALIASES = [
  alias('ajah', 'Badore', 'badore'),
  alias('ajah', 'Abraham Adesanya', 'abraham adesanya'),
  alias('lekki', 'Chevron', 'chevron'),
  alias('lekki', 'VGC', 'vgc'),
  alias('ikeja', 'Allen Avenue', 'allen avenue'),
];

/**
 * What reaches the database when a buyer names a place, and how the areas, their other
 * names and close spellings decide where the buyer is. The fake builder searches like
 * the real one: any word inside an area's name.
 */
describe('LocalLocationAdapter.searchAreas', () => {
  let params: Record<string, unknown>;
  let adapter: LocalLocationAdapter;
  let query: jest.Mock;

  beforeEach(() => {
    const builder: Record<string, jest.Mock> = {};
    Object.assign(builder, {
      innerJoinAndSelect: jest.fn(() => builder),
      where: jest.fn(() => builder),
      andWhere: jest.fn(
        (brackets: { whereFactory?: (qb: unknown) => void }) => {
          // Run the Brackets factory so every orWhere's parameters are captured.
          const inner: Record<string, jest.Mock> = {};
          inner.where = jest.fn((_sql: string, p?: Record<string, unknown>) => {
            Object.assign(params, p);
            return inner;
          });
          inner.orWhere = inner.where;
          brackets.whereFactory?.(inner);
          return builder;
        },
      ),
      orderBy: jest.fn(() => builder),
      take: jest.fn(() => builder),
      getMany: jest.fn(() => {
        const words = Object.values(params).map((p) =>
          String(p).slice(1, -1).toLowerCase(),
        );
        return Promise.resolve(
          words.length === 0
            ? AREAS
            : AREAS.filter((a) =>
                words.some((w) => a.name.toLowerCase().includes(w)),
              ),
        );
      }),
    });
    query = jest.fn().mockResolvedValue([]);
    adapter = new LocalLocationAdapter(
      {
        createQueryBuilder: () => {
          params = {};
          return builder;
        },
      } as unknown as Repository<Area>,
      {
        find: () => Promise.resolve(ALIASES),
      } as unknown as Repository<AreaAlias>,
      { query } as unknown as Repository<UnplacedLocation>,
    );
  });

  const names = (found: { name: string }[]) => found.map((a) => a.name);

  it('ignores punctuation — "Yaba?" is Yaba', async () => {
    // Caught end to end: "do you deliver to Yaba?" searched for "Yaba?" and found nothing.
    expect(names(await adapter.searchAreas('do you deliver to Yaba?'))).toEqual(
      ['Yaba'],
    );
  });

  it('keeps a hyphenated name whole', async () => {
    expect(names(await adapter.searchAreas('Ibeju-Lekki, please'))).toContain(
      'Ibeju-Lekki',
    );
  });

  it('finds the area in a longer description — "Akinwale Road, Ajah"', async () => {
    expect(names(await adapter.searchAreas('Akinwale road Ajah'))).toEqual([
      'Ajah',
    ]);
  });

  it('knows places inside an area by their own names, and says which', async () => {
    expect(await adapter.searchAreas('Badore')).toEqual([
      { id: 'ajah', name: 'Ajah', stateName: 'Lagos', via: 'Badore' },
    ]);
    expect(names(await adapter.searchAreas('12 Allen Avenue'))).toEqual([
      'Ikeja',
    ]);
    // Whole words only: "vgc" is Lekki, "vgcx" is nothing.
    expect(names(await adapter.searchAreas('I live in VGC'))).toEqual([
      'Lekki',
    ]);
    expect(await adapter.searchAreas('vgcx')).toEqual([]);
  });

  it('agrees when the place and the area are both named — "Badore, Ajah"', async () => {
    expect(await adapter.searchAreas('Badore, Ajah')).toEqual([
      { id: 'ajah', name: 'Ajah', stateName: 'Lagos', via: 'Badore' },
    ]);
  });

  it('guesses at a misspelling only when asked, and marks it a guess', async () => {
    expect(await adapter.searchAreas('Leki')).toEqual([]);
    expect(await adapter.searchAreas('Leki', 5, { guesses: true })).toEqual([
      { id: 'lekki', name: 'Lekki', stateName: 'Lagos', guess: true },
    ]);
    expect(
      await adapter.searchAreas('Ajha', 5, { guesses: true }),
    ).toMatchObject([{ name: 'Ajah', guess: true }]);
    expect(
      await adapter.searchAreas('Badoree', 5, { guesses: true }),
    ).toMatchObject([{ name: 'Ajah', via: 'Badore', guess: true }]);
  });

  it('never guesses at a short word, or at something unlike any place', async () => {
    expect(await adapter.searchAreas('Ojo', 5, { guesses: true })).toEqual([]);
    expect(await adapter.searchAreas('Timbuktu', 5, { guesses: true })).toEqual(
      [],
    );
  });

  it('counts a place nobody could place, keeping how it was last written', async () => {
    await adapter.recordUnplaced('  Gbagada   Phase 2 ');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'), [
      'Gbagada Phase 2',
      'gbagada phase 2',
    ]);
  });
});
