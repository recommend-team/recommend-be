import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { createHmac, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';
import { Area } from '../locations/entities/area.entity';
import { AreaAlias } from '../locations/entities/area-alias.entity';
import { normalisePlace } from '../locations/place-match';
import { PLACES_CHANGED_EVENT } from '../../common/events/places-changed.event';
import {
  GooglePlacesClient,
  type LatLng,
  type PlaceComponent,
  type PlaceSuggestion,
} from './google-places.client';

/** A delivery address picked from Google, with the area we deliver it under. */
export interface DeliveryPlace {
  placeId: string;
  /** "Abraham Adesanya, Ajah, Lekki 106104, Lagos, Nigeria" */
  address: string;
  latitude: number;
  longitude: number;
  /** Our area it is in, when one of Google's names for it is one of ours. */
  areaId: string | null;
  areaName: string | null;
}

/** A pick stays good this long: enough to finish a checkout, not to be reused for ever. */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const PLACES_TTL_MS = 60_000;

/**
 * Google's address parts, most specific first. "Abraham Adesanya" (a premise) is found
 * before "Lekki" (the locality) — matching the whole address would name both Ajah and
 * Lekki.
 */
const SPECIFICITY = [
  'subpremise',
  'premise',
  'street_address',
  'route',
  'sublocality_level_2',
  'sublocality_level_1',
  'sublocality',
  'neighborhood',
  'locality',
  'administrative_area_level_3',
  'administrative_area_level_2',
];

interface KnownName {
  normalised: string;
  area: Area;
}

/**
 * Delivery addresses picked from Google Places. The app asks for suggestions, the buyer
 * picks one, and `resolve` returns it with our area and a signed token. Checkout accepts
 * the token instead of a typed address — trusting it without asking Google again, and
 * never trusting an address no one picked.
 */
@Injectable()
export class PlacesService {
  private readonly logger = new Logger(PlacesService.name);
  private names: { at: number; list: KnownName[] } | null = null;
  /** Where each area roughly is, found once and kept: areas don't move. */
  private readonly centres = new Map<string, LatLng | null>();

  constructor(
    private readonly google: GooglePlacesClient,
    private readonly config: ConfigService,
    @InjectRepository(Area) private readonly areas: Repository<Area>,
    @InjectRepository(AreaAlias)
    private readonly aliases: Repository<AreaAlias>,
  ) {}

  /** Suggestions for what the buyer typed, leaning towards their area when known. */
  async suggest(
    input: string,
    sessionToken?: string,
    areaId?: string,
  ): Promise<PlaceSuggestion[]> {
    const text = input.trim().slice(0, 120);
    if (text.length < 2) return [];
    const near = areaId ? await this.centreOf(areaId) : undefined;
    return this.google.autocomplete(text, sessionToken, near ?? undefined);
  }

  /** The picked place, our area for it, and a token checkout will accept. */
  async resolve(
    placeId: string,
    sessionToken?: string,
  ): Promise<{ place: DeliveryPlace; token: string }> {
    const details = await this.google.details(placeId, sessionToken);
    const area = await this.areaFor(details.components);
    const place: DeliveryPlace = {
      placeId: details.placeId,
      address: details.formattedAddress,
      latitude: details.latitude,
      longitude: details.longitude,
      areaId: area?.id ?? null,
      areaName: area?.name ?? null,
    };
    return { place, token: this.sign(place) };
  }

  /** The place a token stands for — refused if it was altered, or is too old. */
  verify(token: string): DeliveryPlace {
    const [body, signature] = token.split('.');
    const refuse = () =>
      new BadRequestException({
        code: 'PLACE_INVALID',
        message: 'Pick the delivery address again — that one has expired.',
      });
    if (!body || !signature) throw refuse();
    const expected = this.signature(body);
    const given = Buffer.from(signature);
    if (
      given.length !== expected.length ||
      !timingSafeEqual(given, Buffer.from(expected))
    ) {
      throw refuse();
    }
    const { at, ...place } = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as DeliveryPlace & { at: number };
    if (typeof at !== 'number' || Date.now() - at > TOKEN_TTL_MS)
      throw refuse();
    return place;
  }

  /**
   * Our area for Google's address parts: the most specific part that is exactly one of
   * our area names or their other names ("Abraham Adesanya" is Ajah). Null when none is.
   */
  async areaFor(components: PlaceComponent[]): Promise<Area | null> {
    const known = await this.knownNames();
    const rank = (component: PlaceComponent) => {
      const ranks = component.types
        .map((type) => SPECIFICITY.indexOf(type))
        .filter((index) => index >= 0);
      return ranks.length > 0 ? Math.min(...ranks) : Number.MAX_SAFE_INTEGER;
    };
    const ordered = components
      .filter((component) => rank(component) !== Number.MAX_SAFE_INTEGER)
      .sort((a, b) => rank(a) - rank(b));

    for (const component of ordered) {
      // "Ajah/Sangotedo" is two names.
      const said = [component.longText, component.shortText]
        .flatMap((text) => text.split(/[/,]/))
        .map(normalisePlace)
        .filter(Boolean);
      const match = known.find((name) => said.includes(name.normalised));
      if (match) return match.area;
    }
    return null;
  }

  /** An admin changed areas or their names. */
  @OnEvent(PLACES_CHANGED_EVENT)
  forgetNames(): void {
    this.names = null;
  }

  private async knownNames(): Promise<KnownName[]> {
    if (this.names && Date.now() - this.names.at < PLACES_TTL_MS) {
      return this.names.list;
    }
    const [areas, aliases] = await Promise.all([
      this.areas.find({ where: { isActive: true }, relations: ['state'] }),
      this.aliases.find(),
    ]);
    const active = areas.filter((area) => area.state?.isActive !== false);
    const byId = new Map(active.map((area) => [area.id, area]));
    const list: KnownName[] = [
      ...active.map((area) => ({
        normalised: normalisePlace(area.name),
        area,
      })),
      ...aliases.flatMap((alias) => {
        const area = byId.get(alias.areaId);
        return area ? [{ normalised: alias.normalised, area }] : [];
      }),
    ];
    this.names = { at: Date.now(), list };
    return list;
  }

  private async centreOf(areaId: string): Promise<LatLng | null> {
    if (this.centres.has(areaId)) return this.centres.get(areaId) ?? null;
    const area = await this.areas.findOne({
      where: { id: areaId },
      relations: ['state'],
    });
    if (!area) return null;
    try {
      const centre = await this.google.locate(
        [area.name, area.state?.name].filter(Boolean).join(', '),
      );
      this.centres.set(areaId, centre);
      return centre;
    } catch (error) {
      // No lean, then — suggestions still come, just not nearest first.
      this.logger.warn(
        `Could not locate ${area.name}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return null;
    }
  }

  private sign(place: DeliveryPlace): string {
    const body = Buffer.from(
      JSON.stringify({ ...place, at: Date.now() }),
      'utf8',
    ).toString('base64url');
    return `${body}.${this.signature(body)}`;
  }

  private signature(body: string): string {
    const secret = this.config.get<string>('places.signingSecret');
    if (!secret)
      throw new Error('PLACES_SIGNING_SECRET or JWT_SECRET must be set');
    return createHmac('sha256', secret).update(body).digest('base64url');
  }
}
