import { Injectable, Optional } from '@nestjs/common';
import { PlacesService } from '../../modules/places/places.service';
import { OnEvent } from '@nestjs/event-emitter';
import { PLACES_CHANGED_EVENT } from '../../common/events/places-changed.event';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { Area } from '../../modules/locations/entities/area.entity';
import { AreaAlias } from '../../modules/locations/entities/area-alias.entity';
import { UnplacedLocation } from '../../modules/locations/entities/unplaced-location.entity';
import {
  containsPlace,
  looksLike,
  normalisePlace,
  placeCandidates,
} from '../../modules/locations/place-match';
import {
  AreaSummary,
  LocationPort,
  PickedAddress,
} from '../ports/location.port';
import { Role } from '../../common/enums/roles.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';

/** How long the list of places is reused before it is read again. */
const PLACES_TTL_MS = 60_000;

interface KnownPlace {
  /** As matched. */
  normalised: string;
  /** As said back: "Badore". Null for the area's own name. */
  alias: string | null;
  area: Area;
}

/**
 * In-process implementation of `LocationPort`.
 */
@Injectable()
export class LocalLocationAdapter implements LocationPort {
  private places: { at: number; list: KnownPlace[] } | null = null;

  constructor(
    @InjectRepository(Area)
    private readonly areasRepository: Repository<Area>,
    @InjectRepository(AreaAlias)
    private readonly aliasesRepository: Repository<AreaAlias>,
    @InjectRepository(UnplacedLocation)
    private readonly unplacedRepository: Repository<UnplacedLocation>,
    @Optional() private readonly placesService?: PlacesService,
  ) {}

  async verifyPlace(token: string): Promise<PickedAddress | null> {
    if (!this.placesService) return null;
    try {
      return Promise.resolve(this.placesService.verify(token));
    } catch {
      return null;
    }
  }

  async searchAreas(
    text: string,
    limit = 5,
    options: { guesses?: boolean } = {},
  ): Promise<AreaSummary[]> {
    const needle = text.trim();
    if (!needle) return [];

    const wanted = clamp(limit);
    const byName = await this.byAreaName(needle, wanted);

    // Places inside an area, as buyers name them: "Badore" is Ajah, "Chevron" Lekki.
    const byAlias = await this.byAlias(needle);
    if (byName.length > 0 || byAlias.length > 0) {
      const merged = [...byName];
      for (const found of byAlias) {
        const same = merged.findIndex((area) => area.id === found.id);
        if (same >= 0) merged[same] = { ...merged[same], via: found.via };
        else merged.push(found);
      }
      return merged.slice(0, wanted);
    }

    // Nothing by name: a near spelling — "Leki", "Ajha" — but only as a guess to confirm.
    return options.guesses ? this.byLikeness(needle, wanted) : [];
  }

  /** An admin changed an area or its names: read the list again on the next message. */
  @OnEvent(PLACES_CHANGED_EVENT)
  forgetPlaces(): void {
    this.places = null;
  }

  async recordUnplaced(text: string): Promise<void> {
    const said = text.trim().replace(/\s+/g, ' ').slice(0, 120);
    const normalised = normalisePlace(said).slice(0, 120);
    if (!normalised) return;
    await this.unplacedRepository.query(
      `INSERT INTO unplaced_locations ("text", "normalised")
       VALUES ($1, $2)
       ON CONFLICT ("normalised") DO UPDATE
         SET "timesSeen" = unplaced_locations."timesSeen" + 1,
             "lastSeenAt" = now(),
             "text" = EXCLUDED."text"`,
      [said, normalised],
    );
  }

  /** By our own area names — the original, word-by-word match. */
  private async byAreaName(
    needle: string,
    wanted: number,
  ): Promise<AreaSummary[]> {
    /*
     * Buyers name places loosely — "Egbeda Junction", "around Ikeja", "Lagos". A single
     * whole-phrase LIKE found none of those: "Egbeda Junction" is not a substring of
     * "Egbeda", and "Lagos" is a state, not an area.
     *
     * So: match if ANY word hits an area name, or if a word names the state (which
     * returns that state's areas as candidates for the buyer to choose from).
     */
    // Punctuation is not part of a place: "do you deliver to Yaba?" must find Yaba, not
    // search for "Yaba?". Hyphens stay — "Ibeju-Lekki" is one name.
    const words = needle
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2)
      .slice(0, 5);

    if (words.length === 0) return [];

    const areas = await this.baseQuery()
      .andWhere(
        new Brackets((where) => {
          words.forEach((word, index) => {
            where
              .orWhere(`area.name ILIKE :w${index}`, {
                [`w${index}`]: `%${word}%`,
              })
              .orWhere(`state.name ILIKE :w${index}`, {
                [`w${index}`]: `%${word}%`,
              });
          });
        }),
      )
      .orderBy('area.name', 'ASC')
      .take(wanted * 6)
      .getMany();

    /*
     * An exact name match wins outright. "Lekki" matching both "Lekki" and "Ibeju-Lekki"
     * would otherwise be treated as ambiguous, and the buyer gets asked which they meant
     * when they already said it precisely.
     */
    const exact = areas.filter((area) =>
      words.some((word) => area.name.toLowerCase() === word.toLowerCase()),
    );
    if (exact.length === 1) return exact.map(toAreaSummary);

    // Closest match first: "Yaba" ahead of "Yaba Estate".
    return areas
      .sort((a, b) => a.name.length - b.name.length)
      .slice(0, wanted)
      .map(toAreaSummary);
  }

  /** Areas whose other names appear, as whole words, in what was said — longest first. */
  private async byAlias(needle: string): Promise<AreaSummary[]> {
    const said = normalisePlace(needle);
    const found: AreaSummary[] = [];
    for (const place of await this.knownPlaces()) {
      if (!place.alias || !containsPlace(said, place.normalised)) continue;
      if (found.some((area) => area.id === place.area.id)) continue;
      found.push({ ...toAreaSummary(place.area), via: place.alias });
    }
    return found;
  }

  /** Areas, or places inside them, spelled almost like something that was said. */
  private async byLikeness(
    needle: string,
    wanted: number,
  ): Promise<AreaSummary[]> {
    const candidates = placeCandidates(needle);
    const found: AreaSummary[] = [];
    for (const place of await this.knownPlaces()) {
      if (found.some((area) => area.id === place.area.id)) continue;
      if (candidates.some((said) => looksLike(said, place.normalised))) {
        found.push({
          ...toAreaSummary(place.area),
          ...(place.alias ? { via: place.alias } : {}),
          guess: true,
        });
      }
    }
    return found.slice(0, wanted);
  }

  /** Every active area's name and its other names, read once a minute. */
  private async knownPlaces(): Promise<KnownPlace[]> {
    if (this.places && Date.now() - this.places.at < PLACES_TTL_MS) {
      return this.places.list;
    }
    const [areas, aliases] = await Promise.all([
      this.baseQuery().getMany(),
      this.aliasesRepository.find(),
    ]);
    const byId = new Map(areas.map((area) => [area.id, area]));
    const list: KnownPlace[] = [
      ...aliases.flatMap((alias) => {
        const area = byId.get(alias.areaId);
        return area
          ? [{ normalised: alias.normalised, alias: alias.name, area }]
          : [];
      }),
      ...areas.map((area) => ({
        normalised: normalisePlace(area.name),
        alias: null,
        area,
      })),
    ].sort((a, b) => b.normalised.length - a.normalised.length);
    this.places = { at: Date.now(), list };
    return list;
  }

  async listAreas(limit = 50): Promise<AreaSummary[]> {
    const areas = await this.baseQuery()
      .orderBy('area.name', 'ASC')
      .take(clamp(limit, 200))
      .getMany();

    return areas.map(toAreaSummary);
  }

  async listServedAreas(limit = 100): Promise<AreaSummary[]> {
    // The same bar a vendor clears to appear in search — approved, with a store page and
    // a category — so "we cover Yaba" is only said where a buyer would find someone.
    const areas = await this.baseQuery()
      .andWhere(
        `EXISTS (
           SELECT 1 FROM vendor_service_areas vsa
           JOIN users vendor ON vendor.id = vsa."vendorId"
           WHERE vsa."areaId" = area.id
             AND vendor.role = :role
             AND vendor.status = :status
             AND vendor.slug IS NOT NULL
             AND COALESCE(vendor."businessCategory", '') <> ''
         )`,
        { role: Role.SELLER, status: SellerStatus.APPROVED },
      )
      .orderBy('state.name', 'ASC')
      .addOrderBy('area.name', 'ASC')
      .take(clamp(limit, 200))
      .getMany();

    return areas.map(toAreaSummary);
  }

  async getAreaById(areaId: string): Promise<AreaSummary | null> {
    const area = await this.baseQuery()
      .andWhere('area.id = :areaId', { areaId })
      .getOne();

    return area ? toAreaSummary(area) : null;
  }

  private baseQuery() {
    return this.areasRepository
      .createQueryBuilder('area')
      .innerJoinAndSelect('area.state', 'state')
      .where('area.isActive = true')
      .andWhere('state.isActive = true');
  }
}

function clamp(value: number, max = 20): number {
  return Math.min(max, Math.max(1, value));
}

function toAreaSummary(area: Area): AreaSummary {
  return {
    id: area.id,
    name: area.name,
    stateName: area.state?.name ?? '',
  };
}
