import { z } from 'zod';
import { ApiPropertyOptional } from '@nestjs/swagger';

export const updateProductSchema = z
  .object({
    name: z.string().min(2).max(100).optional(),
    description: z.string().max(500).optional(),
    price: z.number().positive().multipleOf(0.01).optional(),
    imageUrl: z.string().url().optional(),
    isAvailable: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateProductDto = z.infer<typeof updateProductSchema>;

export class UpdateProductRequestDto {
  @ApiPropertyOptional({ example: 'Jollof Rice' })
  name?: string;

  @ApiPropertyOptional({ example: 'Updated description' })
  description?: string;

  @ApiPropertyOptional({ example: 2800.0 })
  price?: number;

  @ApiPropertyOptional({
    example: 'https://res.cloudinary.com/example/image.jpg',
  })
  imageUrl?: string;

  @ApiPropertyOptional({ example: false })
  isAvailable?: boolean;
}
