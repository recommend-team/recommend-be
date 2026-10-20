import {
  OperatingHours,
  describeOpening,
  openingFields,
  openingStatus,
} from './opening-hours.util';

/** A moment written as Lagos wall-clock time. 2026-10-19 is a Monday. */
const lagos = (local: string) => new Date(`${local}:00+01:00`);

const off = { isOpen: false, open: '00:00', close: '00:00' };
const open = (from: string, to: string) => ({
  isOpen: true,
  open: from,
  close: to,
});

const week = (over: Partial<OperatingHours> = {}): OperatingHours => ({
  sunday: off,
  monday: open('09:00', '19:00'),
  tuesday: open('08:00', '18:00'),
  wednesday: open('09:00', '19:00'),
  thursday: open('09:00', '19:00'),
  friday: open('18:00', '02:00'),
  saturday: off,
  ...over,
});

const status = (
  operatingHours: OperatingHours | null,
  at: string,
  isOpen = true,
) => openingStatus({ isOpen, operatingHours }, lagos(at));

describe('openingStatus', () => {
  it('is open inside the day’s hours, and says when it closes', () => {
    expect(status(week(), '2026-10-19T12:30')).toEqual({
      openNow: true,
      opensAt: null,
      closesAt: lagos('2026-10-19T19:00'),
    });
  });

  it('counts the opening minute and not the closing one', () => {
    expect(status(week(), '2026-10-19T09:00').openNow).toBe(true);
    expect(status(week(), '2026-10-19T19:00').openNow).toBe(false);
  });

  it('before opening, says when it opens today', () => {
    expect(status(week(), '2026-10-20T07:15')).toEqual({
      openNow: false,
      opensAt: lagos('2026-10-20T08:00'),
      closesAt: null,
    });
  });

  it('after closing, says when it opens tomorrow', () => {
    expect(status(week(), '2026-10-19T21:00').opensAt).toEqual(
      lagos('2026-10-20T08:00'),
    );
  });

  it('runs a window past midnight into the next day, even when that day is off', () => {
    expect(status(week(), '2026-10-24T01:30')).toEqual({
      openNow: true,
      opensAt: null,
      closesAt: lagos('2026-10-24T02:00'),
    });
    expect(status(week(), '2026-10-24T02:00').openNow).toBe(false);
  });

  it('on a day off, looks past the weekend to the next open day', () => {
    expect(status(week(), '2026-10-25T10:00')).toEqual({
      openNow: false,
      opensAt: lagos('2026-10-26T09:00'),
      closesAt: null,
    });
  });

  it('reads the day in Lagos, not UTC', () => {
    // 23:30 UTC on Sunday is 00:30 on Monday in Lagos.
    const hours = week({ monday: open('00:00', '06:00') });
    expect(
      openingStatus(
        { isOpen: true, operatingHours: hours },
        new Date('2026-10-18T23:30:00Z'),
      ).openNow,
    ).toBe(true);
  });

  it('treats the same opening and closing time as open all day', () => {
    const hours = week({ monday: open('00:00', '00:00') });
    expect(status(hours, '2026-10-19T03:00')).toEqual({
      openNow: true,
      opensAt: null,
      // Tuesday opens at 08:00, so Monday's 24 hours end at midnight.
      closesAt: lagos('2026-10-20T00:00'),
    });
  });

  it('gives the real closing time when one day’s hours run into the next', () => {
    const hours = week({
      monday: open('00:00', '00:00'),
      tuesday: open('00:00', '18:00'),
    });
    expect(status(hours, '2026-10-19T23:00').closesAt).toEqual(
      lagos('2026-10-20T18:00'),
    );
  });

  it('never closes when every day is all day', () => {
    const always = open('00:00', '00:00');
    const hours = Object.fromEntries(
      Object.keys(week()).map((day) => [day, always]),
    ) as OperatingHours;
    expect(status(hours, '2026-10-21T15:00')).toEqual({
      openNow: true,
      opensAt: null,
      closesAt: null,
    });
  });

  it('with no schedule, is open on the switch alone', () => {
    expect(status(null, '2026-10-25T03:00')).toEqual({
      openNow: true,
      opensAt: null,
      closesAt: null,
    });
  });

  it('is closed when paused, whatever the hours say', () => {
    expect(status(week(), '2026-10-19T12:00', false)).toEqual({
      openNow: false,
      opensAt: null,
      closesAt: null,
    });
    expect(status(null, '2026-10-19T12:00', false).openNow).toBe(false);
  });

  it('treats a missing day as off, and a week with nothing open as closed', () => {
    expect(
      status({ monday: open('09:00', '19:00') }, '2026-10-20T12:00').opensAt,
    ).toEqual(lagos('2026-10-26T09:00'));
    expect(status({ monday: off }, '2026-10-19T12:00')).toEqual({
      openNow: false,
      opensAt: null,
      closesAt: null,
    });
  });
});

describe('openingFields', () => {
  it('gives the times as ISO strings for a response', () => {
    expect(
      openingFields(
        { isOpen: true, operatingHours: week() },
        lagos('2026-10-19T21:00'),
      ),
    ).toEqual({
      openNow: false,
      opensAt: '2026-10-20T07:00:00.000Z',
      closesAt: null,
    });
  });
});

describe('describeOpening', () => {
  const now = lagos('2026-10-19T21:00'); // Monday night

  it.each([
    ['2026-10-19T22:00', 'today at 10pm'],
    ['2026-10-20T08:00', 'tomorrow at 8am'],
    ['2026-10-20T08:30', 'tomorrow at 8:30am'],
    ['2026-10-23T12:00', 'Friday at 12pm'],
    ['2026-10-25T00:00', 'Sunday at 12am'],
    ['2026-10-26T09:00', 'next Monday at 9am'],
  ])('reads %s as "%s"', (at, said) => {
    expect(describeOpening(lagos(at), now)).toBe(said);
  });

  it('counts days in Lagos, not UTC', () => {
    // 23:30 UTC Monday is already Tuesday in Lagos — "tomorrow", not "today".
    expect(
      describeOpening(
        new Date('2026-10-19T23:30:00Z'),
        new Date('2026-10-19T20:00:00Z'),
      ),
    ).toBe('tomorrow at 12:30am');
  });
});
