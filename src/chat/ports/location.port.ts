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
}

export interface LocationPort {
  /** Fuzzy match on what the buyer typed. Empty when nothing plausible matches. */
  searchAreas(text: string, limit?: number): Promise<AreaSummary[]>;
  listAreas(limit?: number): Promise<AreaSummary[]>;
  getAreaById(areaId: string): Promise<AreaSummary | null>;
}
