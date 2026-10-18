import { emptyHarvest, executeTool } from './tools';
import type { AreaSummary, LocationPort } from '../../ports/location.port';
import type { CatalogPort } from '../../ports/catalog.port';

const AJAH: AreaSummary = { id: 'ajah', name: 'Ajah', stateName: 'Lagos' };
const LEKKI: AreaSummary = { id: 'lekki', name: 'Lekki', stateName: 'Lagos' };

/** The assistant learning where a buyer is — however the buyer said it. */
describe('resolve_area', () => {
  const run = async (said: string, found: AreaSummary[]) => {
    const locations = {
      searchAreas: jest.fn().mockResolvedValue(found),
      listAreas: jest.fn().mockResolvedValue([AJAH, LEKKI]),
      recordUnplaced: jest.fn().mockResolvedValue(undefined),
    };
    const harvest = emptyHarvest();
    const answer = await executeTool(
      'resolve_area',
      { text: said },
      {
        catalog: {} as CatalogPort,
        locations: locations as unknown as LocationPort,
        areaId: null,
      },
      harvest,
    );
    return { answer, harvest, locations };
  };

  it('settles on the area a neighbourhood is in, and tells the model to say so', async () => {
    const { answer, harvest, locations } = await run('Ajah Badore', [
      { ...AJAH, via: 'Badore' },
    ]);

    expect(locations.searchAreas).toHaveBeenCalledWith('Ajah Badore', 5, {
      guesses: true,
    });
    expect(harvest.resolvedAreaId).toBe('ajah');
    expect(JSON.parse(answer)).toEqual([
      expect.objectContaining({
        name: 'Ajah',
        buyerSaid: 'Badore',
      }),
    ]);
    expect(answer).toContain('Badore is in Ajah');
  });

  it('waits for a yes on a misspelling, rather than settling on it', async () => {
    const { answer, harvest } = await run('Leki', [{ ...LEKKI, guess: true }]);

    expect(harvest.resolvedAreaId).toBeNull();
    expect(answer).toContain('Did you mean Lekki?');
  });

  it('never says "not covered" when nothing matches — it asks, and the place is counted', async () => {
    const { answer, locations } = await run('Jakande Gate', []);

    expect(locations.recordUnplaced).toHaveBeenCalledWith('Jakande Gate');
    const told = JSON.parse(answer) as { note: string; ourAreas: string[] };
    expect(told.note).toMatch(/Do NOT say we do not cover it/);
    expect(told.ourAreas).toEqual(['Ajah', 'Lekki']);
  });
});
