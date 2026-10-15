/**
 * Where today, this week and this month began, in Lagos.
 *
 * Lagos is on West Africa Time, UTC+1 all year — no daylight saving — so a fixed offset
 * is exact. Computed from UTC rather than the server's own time zone, which on Heroku is
 * UTC and would otherwise roll "today" over at 1am Lagos time.
 */
const LAGOS_OFFSET_MS = 60 * 60_000;

export interface LagosPeriods {
  /** Midnight today. */
  today: Date;
  /** Midnight on Monday of this week. */
  week: Date;
  /** Midnight on the 1st of this month. */
  month: Date;
}

export function lagosPeriodStarts(now: Date = new Date()): LagosPeriods {
  // The wall clock in Lagos, read with UTC getters.
  const lagos = new Date(now.getTime() + LAGOS_OFFSET_MS);
  const midnight = Date.UTC(
    lagos.getUTCFullYear(),
    lagos.getUTCMonth(),
    lagos.getUTCDate(),
  );
  // Monday is the first day: Sunday (0) is six days in, Monday (1) none.
  const daysIntoWeek = (lagos.getUTCDay() + 6) % 7;
  const firstOfMonth = Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), 1);

  // Back from Lagos wall-clock to the real instant.
  const instant = (lagosMidnight: number) =>
    new Date(lagosMidnight - LAGOS_OFFSET_MS);

  return {
    today: instant(midnight),
    week: instant(midnight - daysIntoWeek * 24 * 60 * 60_000),
    month: instant(firstOfMonth),
  };
}
