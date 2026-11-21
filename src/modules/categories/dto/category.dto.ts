import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const name = z
  .string()
  .trim()
  .min(2, 'Give the category a name')
  .max(60, 'Keep the name under 60 characters');

/** 0–50%, to two decimal places. Above 50 is far more likely a typo than a deal. */
const feePercent = z
  .number({ message: 'Enter a percentage' })
  .min(0, "The percentage can't be below 0")
  .max(50, "The percentage can't be above 50")
  .refine(
    // Within float error: 0.07 * 100 is 7.000000000000001.
    (value) => Math.abs(Math.round(value * 100) - value * 100) < 1e-6,
    'Use at most two decimal places',
  );

const keywords = z
  .array(z.string().trim().max(40, 'Keep each word under 40 characters'))
  .max(300, 'Up to 300 words');

export const createCategorySchema = z.object({
  name,
  keywords: keywords.optional(),
  /** Super Admin only. Left out, the category starts at the standard rate. */
  feePercent: feePercent.optional(),
});
export type CreateCategoryDto = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object({
    name: name.optional(),
    keywords: keywords.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Nothing to change');
export type UpdateCategoryDto = z.infer<typeof updateCategorySchema>;

export const changeRateSchema = z.object({ feePercent });
export type ChangeRateDto = z.infer<typeof changeRateSchema>;

/** One vendor's own rate; null removes it, so their category's applies again. */
export const vendorRateSchema = z.object({ feePercent: feePercent.nullable() });
export type VendorRateDto = z.infer<typeof vendorRateSchema>;

export const assignVendorsSchema = z.object({
  vendorIds: z
    .array(z.string().uuid())
    .min(1, 'Choose at least one vendor')
    .max(200, 'Up to 200 at a time'),
});
export type AssignVendorsDto = z.infer<typeof assignVendorsSchema>;

export class VendorRateRequestDto {
  @ApiProperty({
    example: 5,
    nullable: true,
    description: "Null removes their own rate; their category's applies again.",
  })
  feePercent!: number | null;
}

export class AssignVendorsRequestDto {
  @ApiProperty({ type: [String] })
  vendorIds!: string[];
}

export class CreateCategoryRequestDto {
  @ApiProperty({ example: 'Pets' })
  name!: string;

  @ApiPropertyOptional({ example: ['dog food', 'cat litter', 'pet toys'] })
  keywords?: string[];

  @ApiPropertyOptional({
    example: 8,
    description: 'Super Admin only. Defaults to the standard rate.',
  })
  feePercent?: number;
}

export class UpdateCategoryRequestDto {
  @ApiPropertyOptional({ example: 'Pets' })
  name?: string;

  @ApiPropertyOptional({ example: ['dog food', 'cat litter'] })
  keywords?: string[];

  @ApiPropertyOptional({ example: false })
  isActive?: boolean;
}

export class ChangeRateRequestDto {
  @ApiProperty({ example: 10 })
  feePercent!: number;
}
