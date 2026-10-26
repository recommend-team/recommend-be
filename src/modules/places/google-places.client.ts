import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const API = 'https://places.googleapis.com/v1';
/** Long enough for Google on a slow day, short enough that a buyer isn't left waiting. */
const TIMEOUT_MS = 5000;

export interface PlaceSuggestion {
  placeId: string;
  /** "Abraham Adesanya, Ajah, Lekki, Nigeria" */
  text: string;
  /** "Abraham Adesanya" */
  main: string;
  /** "Ajah, Lekki, Nigeria" */
  secondary: string;
}

export interface PlaceComponent {
  longText: string;
  shortText: string;
  types: string[];
}

export interface PlaceDetails {
  placeId: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
  components: PlaceComponent[];
}

export interface LatLng {
  latitude: number;
  longitude: number;
}

/**
 * Google Places API (New), and only what delivery addresses need: suggestions as the
 * buyer types, the chosen place's address and pin, and where an area roughly is (to lean
 * suggestions towards it).
 *
 * A session token ties a run of suggestions to the one place chosen, so Google bills
 * the lot as one session.
 */
@Injectable()
export class GooglePlacesClient {
  private readonly logger = new Logger(GooglePlacesClient.name);

  constructor(private readonly config: ConfigService) {}

  get configured(): boolean {
    return !!this.config.get<string>('places.apiKey');
  }

  async autocomplete(
    input: string,
    sessionToken: string | undefined,
    near?: LatLng,
  ): Promise<PlaceSuggestion[]> {
    const body = {
      input,
      ...(sessionToken ? { sessionToken } : {}),
      includedRegionCodes: this.countries(),
      languageCode: 'en',
      ...(near
        ? { locationBias: { circle: { center: near, radius: 20000 } } }
        : {}),
    };
    const data = await this.call<{
      suggestions?: {
        placePrediction?: {
          placeId: string;
          text?: { text: string };
          structuredFormat?: {
            mainText?: { text: string };
            secondaryText?: { text: string };
          };
        };
      }[];
    }>('/places:autocomplete', { method: 'POST', body: JSON.stringify(body) });

    return (data.suggestions ?? []).flatMap(({ placePrediction: p }) =>
      p?.placeId
        ? [
            {
              placeId: p.placeId,
              text: p.text?.text ?? '',
              main: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
              secondary: p.structuredFormat?.secondaryText?.text ?? '',
            },
          ]
        : [],
    );
  }

  async details(
    placeId: string,
    sessionToken: string | undefined,
  ): Promise<PlaceDetails> {
    const query = sessionToken
      ? `?sessionToken=${encodeURIComponent(sessionToken)}`
      : '';
    const data = await this.call<{
      id: string;
      formattedAddress?: string;
      location?: LatLng;
      addressComponents?: PlaceComponent[];
    }>(`/places/${encodeURIComponent(placeId)}${query}`, {
      method: 'GET',
      fieldMask: 'id,formattedAddress,location,addressComponents',
    });
    if (!data.location || !data.formattedAddress) {
      throw new ServiceUnavailableException({
        code: 'PLACE_INCOMPLETE',
        message: 'That place has no address we can deliver to. Try another.',
      });
    }
    return {
      placeId: data.id,
      formattedAddress: data.formattedAddress,
      latitude: data.location.latitude,
      longitude: data.location.longitude,
      components: data.addressComponents ?? [],
    };
  }

  /** Where a named place roughly is — "Ajah, Lagos" — or null. */
  async locate(text: string): Promise<LatLng | null> {
    const data = await this.call<{ places?: { location?: LatLng }[] }>(
      '/places:searchText',
      {
        method: 'POST',
        body: JSON.stringify({
          textQuery: text,
          ...(this.countries().length === 1
            ? { regionCode: this.countries()[0] }
            : {}),
        }),
        fieldMask: 'places.location',
      },
    );
    return data.places?.[0]?.location ?? null;
  }

  private countries(): string[] {
    return this.config.get<string[]>('places.countries') ?? ['ng'];
  }

  private async call<T>(
    path: string,
    {
      method,
      body,
      fieldMask,
    }: { method: string; body?: string; fieldMask?: string },
  ): Promise<T> {
    const key = this.config.get<string>('places.apiKey');
    if (!key) {
      throw new ServiceUnavailableException({
        code: 'PLACES_UNAVAILABLE',
        message:
          'Address search is not available right now — type the address instead.',
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${API}${path}`, {
        method,
        body,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          ...(fieldMask ? { 'X-Goog-FieldMask': fieldMask } : {}),
        },
      });
      if (!response.ok) {
        this.logger.warn(
          `Google Places ${path.split('?')[0]} answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
        );
        throw new Error(`status ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.warn(
        `Google Places ${path.split('?')[0]} failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      throw new ServiceUnavailableException({
        code: 'PLACES_UNAVAILABLE',
        message:
          'Address search is not available right now — type the address instead.',
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
