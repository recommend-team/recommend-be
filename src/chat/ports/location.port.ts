/**
 * Where a buyer is. Areas are admin-managed rows (see LocationsModule) — the chat
 * context resolves free text like "yaba" or "I'm in Lekki" to one of them, and never
 * invents a place that admin has not created.
 */

export const LOCATION_PORT = Symbol('LOCATION_PORT');

export interface AreaSummary {
  id: string;
  name: string;
  stateName: string;
  /** The place the buyer named that we know is in this area — "Badore", for Ajah. */
  via?: string;
  /** Spelled differently from any place we know ("Leki"): confirm before using it. */
  guess?: boolean;
}

/** An address the buyer picked from Google, checked: where it is, and our area for it. */
export interface PickedAddress {
  placeId: string;
  address: string;
  latitude: number;
  longitude: number;
  areaId: string | null;
  areaName: string | null;
}

export interface LocationPort {
  /**
   * The areas what the buyer typed points to: by our area names, then by the other names
   * of places inside them ("Badore" is in Ajah), then — with `guesses` — by close
   * spellings, marked `guess`. Empty when nothing plausible matches.
   */
  searchAreas(
    text: string,
    limit?: number,
    options?: { guesses?: boolean },
  ): Promise<AreaSummary[]>;
  /** A place a buyer named that matched nothing — counted, for an admin to place. */
  recordUnplaced(text: string): Promise<void>;
  /** The address a picked-place token stands for, or null if it was altered or is old. */
  verifyPlace(token: string): Promise<PickedAddress | null>;
  listAreas(limit?: number): Promise<AreaSummary[]>;
  /**
   * Areas a buyer can actually order in: at least one approved vendor serves them. What
   * the assistant says when asked where Recommend operates — never an area with no one.
   */
  listServedAreas(limit?: number): Promise<AreaSummary[]>;
  getAreaById(areaId: string): Promise<AreaSummary | null>;
}
