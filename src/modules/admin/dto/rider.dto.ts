import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RiderType } from '../../../common/enums/rider-type.enum';
import { toE164 } from '../../../common/utils/phone.util';

/**
 * A rider an admin adds by hand — someone they have vetted and can reach by phone. No
 * password: until riders have an app there is nothing for them to sign in to.
 *
 * The phone is normalised to E.164 here, so "0801 234 5678" and "+2348012345678" are the
 * same rider and the second is refused as a duplicate.
 */
export const createRiderSchema = z.object({
  firstName: z.string().trim().min(2, 'Enter the rider’s first name').max(50),
  lastName: z.string().trim().min(2, 'Enter the rider’s last name').max(50),
  phoneNumber: z
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
    }),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email')
    .max(254)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  riderType: z.nativeEnum(RiderType).default(RiderType.INDIVIDUAL),
  note: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value) => value || undefined),
});

export type CreateRiderDto = z.infer<typeof createRiderSchema>;

export class CreateRiderSwaggerDto {
  @ApiProperty({ example: 'Musa' })
  firstName!: string;

  @ApiProperty({ example: 'Bello' })
  lastName!: string;

  @ApiProperty({ example: '0801 234 5678', description: 'Any Nigerian format' })
  phoneNumber!: string;

  @ApiPropertyOptional({ example: 'musa@example.com' })
  email?: string;

  @ApiPropertyOptional({ enum: RiderType, default: RiderType.INDIVIDUAL })
  riderType?: RiderType;

  @ApiPropertyOptional({
    example: 'Has a bike. Covers Lekki Phase 1 and Ajah.',
  })
  note?: string;
}

export const assignRiderSchema = z.object({
  riderId: z.string().uuid('Choose a rider'),
});

export type AssignRiderDto = z.infer<typeof assignRiderSchema>;

export class AssignRiderSwaggerDto {
  @ApiProperty({ format: 'uuid' })
  riderId!: string;
}
