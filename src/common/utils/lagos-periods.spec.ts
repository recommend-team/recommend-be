import { lagosPeriodStarts } from './lagos-periods';

/** Lagos wall-clock time, written the way a person would say it, as the real instant. */
const lagos = (iso: string) => new Date(`${iso}+01:00`);

describe('today, this week and this month, in Lagos', () => {
  it('starts today at midnight Lagos time, not UTC', () => {
    // Wednesday 15 October 2026, 9:30am in Lagos.
    const periods = lagosPeriodStarts(lagos('2026-10-15T09:30:00'));

    expect(periods.today).toEqual(lagos('2026-10-15T00:00:00'));
    expect(periods.today.toISOString()).toBe('2026-10-14T23:00:00.000Z');
  });

  it('counts the half hour after midnight in Lagos as the new day', () => {
    // 12:30am Thursday in Lagos is still Wednesday in UTC — the trap this avoids.
    const periods = lagosPeriodStarts(lagos('2026-10-16T00:30:00'));

    expect(periods.today).toEqual(lagos('2026-10-16T00:00:00'));
  });

  it('starts the week on Monday', () => {
    const wednesday = lagosPeriodStarts(lagos('2026-10-15T09:30:00'));
    expect(wednesday.week).toEqual(lagos('2026-10-12T00:00:00'));
  });

  it('treats Sunday as the end of the week, not the start', () => {
    const sunday = lagosPeriodStarts(lagos('2026-10-18T22:00:00'));
    expect(sunday.week).toEqual(lagos('2026-10-12T00:00:00'));
  });

  it('starts a new week on Monday morning', () => {
    const monday = lagosPeriodStarts(lagos('2026-10-19T00:05:00'));
    expect(monday.week).toEqual(lagos('2026-10-19T00:00:00'));
    expect(monday.today).toEqual(monday.week);
  });

  it('starts the month on the 1st', () => {
    const periods = lagosPeriodStarts(lagos('2026-10-15T09:30:00'));
    expect(periods.month).toEqual(lagos('2026-10-01T00:00:00'));
  });

  it('rolls into a new month — and year — at Lagos midnight', () => {
    const periods = lagosPeriodStarts(lagos('2027-01-01T00:10:00'));
    expect(periods.month).toEqual(lagos('2027-01-01T00:00:00'));
    expect(periods.today).toEqual(periods.month);
  });
});
