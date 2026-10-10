import { LocalLocationAdapter } from './local-location.adapter';
import type { Area } from '../../modules/locations/entities/area.entity';
import type { Repository } from 'typeorm';

/**
 * What reaches the database when a buyer names a place. The SQL itself runs against
 * Postgres in the end-to-end test; this pins the words searched for.
 */
describe('LocalLocationAdapter.searchAreas', () => {
  let params: Record<string, unknown>;
  let adapter: LocalLocationAdapter;

  beforeEach(() => {
    params = {};
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
      getMany: jest.fn().mockResolvedValue([]),
    });
    adapter = new LocalLocationAdapter({
      createQueryBuilder: () => builder,
    } as unknown as Repository<Area>);
  });

  const searched = () => Object.values(params);

  it('ignores punctuation — "Yaba?" is Yaba', async () => {
    // Caught end to end: "do you deliver to Yaba?" searched for "Yaba?" and found nothing.
    await adapter.searchAreas('do you deliver to Yaba?');

    expect(searched()).toContain('%Yaba%');
    expect(searched()).not.toContain('%Yaba?%');
  });

  it('keeps a hyphenated name whole', async () => {
    await adapter.searchAreas('Ibeju-Lekki, please');

    expect(searched()).toContain('%Ibeju-Lekki%');
  });

  it('never passes a LIKE wildcard through', async () => {
    await adapter.searchAreas('Yaba%_');

    expect(searched()).toEqual(['%Yaba%']);
  });
});
