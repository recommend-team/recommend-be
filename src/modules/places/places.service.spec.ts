import { BadRequestException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { PlacesService, type DeliveryPlace } from './places.service';
import type {
  GooglePlacesClient,
  PlaceComponent,
} from './google-places.client';
import type { Area } from '../locations/entities/area.entity';
import type { AreaAlias } from '../locations/entities/area-alias.entity';

const LAGOS = { id: 'lagos', name: 'Lagos', isActive: true };
const area = (id: string, name: string) =>
  ({ id, name, isActive: true, state: LAGOS }) as unknown as Area;
const AJAH = area('ajah', 'Ajah');
const LEKKI = area('lekki', 'Lekki');
const SANGOTEDO = area('sangotedo', 'Sangotedo');

const part = (longText: string, ...types: string[]): PlaceComponent => ({
  longText,
  shortText: longText,
  types,
});

/** "Abraham Adesanya, Ajah, Lekki 106104, Lagos, Nigeria", as Google sends it. */
const ABRAHAM_ADESANYA = [
  part('Abraham Adesanya', 'premise'),
  part('Ajah', 'neighborhood', 'political'),
  part('Lekki', 'locality', 'political'),
  part('Ajah/Sangotedo', 'administrative_area_level_3', 'political'),
  part('Eti Osa', 'administrative_area_level_2', 'political'),
  part('Lagos', 'administrative_area_level_1', 'political'),
  part('Nigeria', 'country', 'political'),
];

describe('PlacesService', () => {
  let google: jest.Mocked<
    Pick<GooglePlacesClient, 'autocomplete' | 'details' | 'locate'>
  >;
  let aliases: AreaAlias[];
  let service: PlacesService;

  beforeEach(() => {
    google = {
      autocomplete: jest.fn().mockResolvedValue([]),
      details: jest.fn(),
      locate: jest.fn().mockResolvedValue({ latitude: 6.47, longitude: 3.58 }),
    };
    aliases = [];
    service = new PlacesService(
      google as unknown as GooglePlacesClient,
      { get: () => 'test-secret' } as never,
      {
        find: () => Promise.resolve([AJAH, LEKKI, SANGOTEDO]),
        findOne: () => Promise.resolve(AJAH),
      } as unknown as Repository<Area>,
      {
        find: () => Promise.resolve(aliases),
      } as unknown as Repository<AreaAlias>,
    );
  });

  describe('our area for Google’s address', () => {
    it('takes the most specific part we know — Ajah, not Lekki', async () => {
      expect(await service.areaFor(ABRAHAM_ADESANYA)).toBe(AJAH);
    });

    it('knows a place by one of the area’s other names', async () => {
      aliases = [
        {
          id: 'a1',
          areaId: 'ajah',
          name: 'Abraham Adesanya',
          normalised: 'abraham adesanya',
        } as AreaAlias,
      ];
      // Even with no neighbourhood part, the premise names Ajah.
      expect(
        await service.areaFor([
          part('Abraham Adesanya', 'premise'),
          part('Lekki', 'locality'),
        ]),
      ).toBe(AJAH);
    });

    it('reads "Ajah/Sangotedo" as two names', async () => {
      expect(
        await service.areaFor([
          part('Ajah/Sangotedo', 'administrative_area_level_3'),
        ]),
      ).toBe(AJAH);
    });

    it('never matches on the state or the country, and says so when nothing fits', async () => {
      expect(
        await service.areaFor([
          part('Lagos', 'administrative_area_level_1'),
          part('Nigeria', 'country'),
        ]),
      ).toBeNull();
    });
  });

  describe('a picked place', () => {
    beforeEach(() => {
      google.details.mockResolvedValue({
        placeId: 'ChIJabc',
        formattedAddress:
          'Abraham Adesanya, Ajah, Lekki 106104, Lagos, Nigeria',
        latitude: 6.469065,
        longitude: 3.585036,
        components: ABRAHAM_ADESANYA,
      });
    });

    it('comes with our area and a token checkout trusts', async () => {
      const { place, token } = await service.resolve('ChIJabc', 'session-1234');

      expect(place).toEqual({
        placeId: 'ChIJabc',
        address: 'Abraham Adesanya, Ajah, Lekki 106104, Lagos, Nigeria',
        latitude: 6.469065,
        longitude: 3.585036,
        areaId: 'ajah',
        areaName: 'Ajah',
      });
      expect(service.verify(token)).toEqual(place);
    });

    it('refuses a token anyone changed', async () => {
      const { token } = await service.resolve('ChIJabc');
      const [body, signature] = token.split('.');
      const forged = Buffer.from(
        JSON.stringify({
          ...(JSON.parse(
            Buffer.from(body, 'base64url').toString(),
          ) as DeliveryPlace),
          address: 'Somewhere else entirely',
        }),
      ).toString('base64url');

      expect(() => service.verify(`${forged}.${signature}`)).toThrow(
        BadRequestException,
      );
      expect(() => service.verify('nonsense')).toThrow(BadRequestException);
    });

    it('refuses a token older than a day', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now - 25 * 60 * 60 * 1000);
      const { token } = await service.resolve('ChIJabc');
      jest.spyOn(Date, 'now').mockReturnValue(now);

      expect(() => service.verify(token)).toThrow(BadRequestException);
      jest.restoreAllMocks();
    });
  });

  describe('suggestions', () => {
    it('asks Google nothing for one letter', async () => {
      expect(await service.suggest('a')).toEqual([]);
      expect(google.autocomplete).not.toHaveBeenCalled();
    });

    it('leans towards the buyer’s area, finding where it is only once', async () => {
      await service.suggest('Allen', 'session-1234', 'ajah');
      await service.suggest('Allen Av', 'session-1234', 'ajah');

      expect(google.locate).toHaveBeenCalledTimes(1);
      expect(google.locate).toHaveBeenCalledWith('Ajah, Lagos');
      expect(google.autocomplete).toHaveBeenLastCalledWith(
        'Allen Av',
        'session-1234',
        { latitude: 6.47, longitude: 3.58 },
      );
    });

    it('still suggests when the area can’t be found — just without the lean', async () => {
      google.locate.mockRejectedValue(new Error('down'));
      await service.suggest('Allen', undefined, 'ajah');

      expect(google.autocomplete).toHaveBeenCalledWith(
        'Allen',
        undefined,
        undefined,
      );
    });
  });
});
