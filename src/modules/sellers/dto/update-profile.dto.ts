import { ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

const dayScheduleSchema = z.object({
  isOpen: z.boolean(),
  open: z.string().regex(timeRegex, 'Time must be in HH:mm format'),
  close: z.string().regex(timeRegex, 'Time must be in HH:mm format'),
});

const days = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export const updateProfileSchema = z
  .object({
    businessName: z.string().min(2).max(100).optional(),
    businessAddress: z.string().min(5).max(255).optional(),
    businessDescription: z.string().max(500).optional(),
    businessCategory: z.string().min(2).max(100).optional(),
    // Areas are admin-created rows now, not free text — send their ids.
    areaIds: z
      .array(z.string().uuid('Each area id must be a valid UUID'))
      .max(20, 'A vendor can serve at most 20 areas')
      .optional(),
    businessLogoUrl: z
      .string()
      .url('businessLogoUrl must be a valid URL')
      .optional(),
    businessBannerUrl: z
      .string()
      .url('businessBannerUrl must be a valid URL')
      .optional(),
    whatsappNumber: z
      .string()
      .regex(/^\+?[1-9]\d{1,14}$/, 'Invalid WhatsApp number format')
      .optional(),
    isOpen: z.boolean().optional(),
    operatingHours: z
      .object(
        Object.fromEntries(
          days.map((d) => [d, dayScheduleSchema.optional()]),
        ) as {
          [K in (typeof days)[number]]?: typeof dayScheduleSchema;
        },
      )
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;

export class UpdateProfileRequestDto {
  @ApiPropertyOptional({ example: "Mama's Kitchen" })
  businessName?: string;

  @ApiPropertyOptional({ example: '12 Broad Street, Lagos Island' })
  businessAddress?: string;

  @ApiPropertyOptional({
    example: 'Authentic Nigerian cuisine delivered fresh',
  })
  businessDescription?: string;

  @ApiPropertyOptional({ example: 'Restaurant' })
  businessCategory?: string;

  @ApiPropertyOptional({
    description:
      'Ids of the areas this vendor serves. Get them from GET /locations/states/:id/areas. ' +
      "Sending the list replaces the vendor's current coverage.",
    example: [
      '123e4567-e89b-12d3-a456-426614174000',
      '223e4567-e89b-12d3-a456-426614174001',
    ],
    type: [String],
  })
  areaIds?: string[];

  @ApiPropertyOptional({
    example: 'https://res.cloudinary.com/example/logo.jpg',
  })
  businessLogoUrl?: string;

  @ApiPropertyOptional({
    example: 'https://res.cloudinary.com/example/banner.jpg',
  })
  businessBannerUrl?: string;

  @ApiPropertyOptional({ example: '+2348012345678' })
  whatsappNumber?: string;

  @ApiPropertyOptional({ example: true })
  isOpen?: boolean;

  @ApiPropertyOptional({
    example: {
      monday: { isOpen: true, open: '08:00', close: '20:00' },
      tuesday: { isOpen: true, open: '08:00', close: '20:00' },
      saturday: { isOpen: true, open: '10:00', close: '18:00' },
      sunday: { isOpen: false, open: '00:00', close: '00:00' },
    },
  })
  operatingHours?: Record<
    string,
    { isOpen: boolean; open: string; close: string }
  >;
}
