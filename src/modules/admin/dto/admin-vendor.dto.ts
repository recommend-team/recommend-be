import { z } from 'zod';
import { VendorType } from '../../../common/enums/vendor-type.enum';
import { toE164 } from '../../../common/utils/phone.util';
import { profileFieldsSchema } from '../../sellers/dto/update-profile.dto';

/**
 * What an admin sends to set up or change a vendor. The store fields are the vendor's own
 * (`profileFieldsSchema`), so the two cannot disagree about what a valid store is.
 */

/** "0801 234 5678" or "+2348012345678" → "+2348012345678", as a rider's number is. */
const phoneNumber = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const e164 = toE164(value);
    if (!e164) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Enter a valid phone number',
      });
      return z.NEVER;
    }
    return e164;
  });

const email = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email')
  .max(254);

const name = (what: string) =>
  z.string().trim().min(2, `Enter the ${what}`).max(50);

/** A vendor the admin sets up. They are emailed a link to choose their own password. */
export const createVendorSchema = z.object({
  firstName: name('owner’s first name'),
  lastName: name('owner’s last name'),
  email,
  phoneNumber,
  vendorType: z.nativeEnum(VendorType, {
    errorMap: () => ({ message: 'Choose registered or not registered' }),
  }),
  businessName: z.string().trim().min(2, 'Enter the business name').max(100),
  businessAddress: z.string().trim().min(5, 'Enter the address').max(255),
  businessCategory: z.string().trim().min(2, 'Enter what they sell').max(100),
  businessDescription: z.string().trim().max(500).optional(),
  areaIds: profileFieldsSchema.shape.areaIds,
});

export type CreateVendorDto = z.infer<typeof createVendorSchema>;

/**
 * Any of the vendor's store fields, plus the owner's details the vendor app cannot change:
 * name, phone, registered or not, and the monthly order quota (null for no limit).
 */
export const adminUpdateVendorSchema = profileFieldsSchema
  .extend({
    firstName: name('owner’s first name').optional(),
    lastName: name('owner’s last name').optional(),
    phoneNumber: phoneNumber.optional(),
    vendorType: z.nativeEnum(VendorType).optional(),
    orderQuota: z.number().int().min(0).max(100000).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Nothing to change',
  });

export type AdminUpdateVendorDto = z.infer<typeof adminUpdateVendorSchema>;

/** The owner fields, split from the store fields the vendor's own update handles. */
export const OWNER_FIELDS = [
  'firstName',
  'lastName',
  'phoneNumber',
  'vendorType',
  'orderQuota',
] as const;

export const changeVendorEmailSchema = z.object({ email });
export type ChangeVendorEmailDto = z.infer<typeof changeVendorEmailSchema>;
