/**
 * When a vendor can be bought from (OPENING_HOURS_PLAN.md). The one place the rule
 * lives — checkout, the storefront and the chat all ask here.
 *
 * A vendor is open when their switch is on and, if they have set a weekly schedule, the
 * time in Lagos falls inside one of its windows. No schedule means the switch alone.
 */

export interface DaySchedule {
  isOpen: boolean;
  /** "HH:mm", Lagos time. */
  open: string;
  /** "HH:mm". Earlier than `open` closes the next day; equal to it means all day. */
  close: string;
}

export type OperatingHours = Record<string, DaySchedule>;

export interface OpeningStatus {
  openNow: boolean;
  /** When it next opens — null if open now, paused, or no day of the week is open. */
  opensAt: Date | null;
  /** When the current window ends — null if closed, no schedule, or it never closes. */
  closesAt: Date | null;
}

/** Index matches `Date#getUTCDay` on a Lagos-shifted date: 0 is Sunday. */
export const WEEK_DAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/** WAT is UTC+1 all year — Nigeria has no daylight saving. */
const LAGOS_OFFSET_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function openingStatus(
  vendor: { isOpen: boolean; operatingHours: OperatingHours | null },
  now: Date,
): OpeningStatus {
  if (!vendor.isOpen) return { openNow: false, opensAt: null, closesAt: null };
  if (!vendor.operatingHours) {
    return { openNow: true, opensAt: null, closesAt: null };
  }

  const at = now.getTime();
  const windows = windowsAround(vendor.operatingHours, now);
  const current = windows.find(([start, end]) => start <= at && at < end);
  if (current) {
    // A window running past the week we looked at is one that never shuts.
    const closesAt =
      current[1] >= at + 7 * DAY_MS ? null : new Date(current[1]);
    return { openNow: true, opensAt: null, closesAt };
  }
  const next = windows.find(([start]) => start > at);
  return {
    openNow: false,
    opensAt: next ? new Date(next[0]) : null,
    closesAt: null,
  };
}

/** `openingStatus` as a response carries it: the times as ISO strings. */
export interface OpeningFields {
  openNow: boolean;
  opensAt: string | null;
  closesAt: string | null;
}

export function openingFields(
  vendor: { isOpen: boolean; operatingHours: OperatingHours | null },
  now: Date,
): OpeningFields {
  const status = openingStatus(vendor, now);
  return {
    openNow: status.openNow,
    opensAt: status.opensAt?.toISOString() ?? null,
    closesAt: status.closesAt?.toISOString() ?? null,
  };
}

/**
 * When a vendor opens, as a buyer would say it in Lagos: "today at 9am", "tomorrow at
 * 8:30am", "Monday at 9am", or "next Monday at 9am" a week on.
 */
export function describeOpening(at: Date, now: Date): string {
  const lagosDay = (date: Date) =>
    Math.floor((date.getTime() + LAGOS_OFFSET_MS) / DAY_MS);
  const days = lagosDay(at) - lagosDay(now);
  const local = new Date(at.getTime() + LAGOS_OFFSET_MS);
  const name = WEEK_DAYS[local.getUTCDay()];
  const weekday = name[0].toUpperCase() + name.slice(1);
  const day =
    days <= 0
      ? 'today'
      : days === 1
        ? 'tomorrow'
        : days >= 7
          ? `next ${weekday}`
          : weekday;

  const hours = local.getUTCHours();
  const minutes = local.getUTCMinutes();
  const clock =
    `${hours % 12 || 12}` +
    (minutes ? `:${String(minutes).padStart(2, '0')}` : '') +
    (hours < 12 ? 'am' : 'pm');
  return `${day} at ${clock}`;
}

/**
 * Every open window from yesterday (whose hours may run past midnight into today) to a
 * week ahead, as [start, end) epoch ms — sorted, with touching or overlapping ones merged
 * so "closes at" is when the vendor actually stops, not a midnight between two days.
 */
function windowsAround(hours: OperatingHours, now: Date): [number, number][] {
  const lagos = new Date(now.getTime() + LAGOS_OFFSET_MS);
  const todayStart =
    Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate()) -
    LAGOS_OFFSET_MS;
  const today = lagos.getUTCDay();

  const windows: [number, number][] = [];
  for (let offset = -1; offset <= 7; offset++) {
    const day = hours[WEEK_DAYS[(today + offset + 7) % 7]];
    if (!day?.isOpen) continue;
    const open = minutesOf(day.open);
    const close = minutesOf(day.close);
    if (open === null || close === null) continue;

    const dayStart = todayStart + offset * DAY_MS;
    const start = dayStart + open * MINUTE_MS;
    const end = dayStart + close * MINUTE_MS + (close <= open ? DAY_MS : 0);
    windows.push([start, end]);
  }

  const merged: [number, number][] = [];
  for (const window of windows.sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && window[0] <= last[1]) last[1] = Math.max(last[1], window[1]);
    else merged.push([...window]);
  }
  return merged;
}

function minutesOf(time: string): number | null {
  const match = TIME.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
