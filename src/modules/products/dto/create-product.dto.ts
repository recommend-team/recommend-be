import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const createProductSchema = z.object({
  name: z
    .string()
    .min(2, 'Name must be at least 2 characters')
    .max(100, 'Name must be at most 100 characters'),
  description: z
    .string()
    .max(500, 'Description must be at most 500 characters')
    .optional(),
  price: z
    .number({
      required_error: 'Price is required',
      invalid_type_error: 'Price must be a number',
    })
    .positive('Price must be positive')
    .multipleOf(0.01, 'Price must have at most 2 decimal places'),
  imageUrl: z.string().url('imageUrl must be a valid URL').optional(),
  isAvailable: z.boolean().optional().default(true),
});

export type CreateProductDto = z.infer<typeof createProductSchema>;

/** Swagger class for @ApiBody */
export class CreateProductRequestDto {
  @ApiProperty({ example: 'Jollof Rice', minLength: 2, maxLength: 100 })
  name!: string;

  @ApiPropertyOptional({
    example: 'Smoky Nigerian jollof rice with grilled chicken',
    maxLength: 500,
  })
  description?: string;

  @ApiProperty({ example: 2500.0, description: 'Price in NGN' })
  price!: number;

  @ApiPropertyOptional({
    example: 'https://res.cloudinary.com/example/image.jpg',
  })
  imageUrl?: string;

  @ApiPropertyOptional({ example: true, default: true })
  isAvailable?: boolean;
}
