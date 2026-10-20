import { updateProfileSchema } from './update-profile.dto';
import { adminUpdateVendorSchema } from '../../admin/dto/admin-vendor.dto';

const day = (isOpen: boolean, open = '09:00', close = '19:00') => ({
  isOpen,
  open,
  close,
});
const week = {
  monday: day(true),
  tuesday: day(true, '08:00', '18:00'),
  wednesday: day(true),
  thursday: day(true),
  friday: day(true, '18:00', '02:00'),
  saturday: day(false),
  sunday: day(false, '00:00', '00:00'),
};

const messages = (result: {
  success: boolean;
  error?: { issues: { message: string }[] };
}) =>
  result.success ? [] : result.error!.issues.map((issue) => issue.message);

describe('saving opening hours', () => {
  it('takes a full week, including hours past midnight', () => {
    expect(
      updateProfileSchema.safeParse({ operatingHours: week }).success,
    ).toBe(true);
  });

  it('refuses a partial week, naming the missing day', () => {
    const partial: Partial<typeof week> = { ...week };
    delete partial.sunday;
    const result = updateProfileSchema.safeParse({ operatingHours: partial });
    expect(messages(result)).toEqual([
      "Send sunday's hours too — all seven days are needed",
    ]);
  });

  it('refuses a week with every day off, pointing to the pause switch', () => {
    const closed = Object.fromEntries(
      Object.keys(week).map((name) => [name, day(false)]),
    );
    const result = updateProfileSchema.safeParse({ operatingHours: closed });
    expect(messages(result)[0]).toMatch(/pause the store instead/);
  });

  it('refuses a time not written HH:mm', () => {
    const result = updateProfileSchema.safeParse({
      operatingHours: { ...week, monday: day(true, '9am', '19:00') },
    });
    expect(result.success).toBe(false);
  });

  it('clears the schedule with null', () => {
    const result = updateProfileSchema.safeParse({ operatingHours: null });
    expect(result.success && result.data.operatingHours).toBeNull();
  });

  it('holds an admin’s edit to the same rules', () => {
    const partial: Partial<typeof week> = { ...week };
    delete partial.sunday;
    expect(
      adminUpdateVendorSchema.safeParse({ operatingHours: partial }).success,
    ).toBe(false);
    expect(
      adminUpdateVendorSchema.safeParse({ operatingHours: week }).success,
    ).toBe(true);
  });
});
