import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FulfillmentType } from '../../../common/enums/fulfillment-type.enum';

export const createOrderSchema = z
  .object({
    productId: z.string().uuid('productId must be a valid UUID'),
    quantity: z
      .number({ required_error: 'Quantity is required' })
      .int('Quantity must be a whole number')
      .min(1, 'Quantity must be at least 1'),
    buyerPhone: z
      .string()
      .regex(
        /^\+[1-9]\d{7,14}$/,
        'buyerPhone must be in E.164 format (e.g. +2348012345678)',
      ),
    buyerName: z.string().min(2, 'Buyer name must be at least 2 characters'),
    buyerEmail: z.string().email('Invalid email').optional(),
    fulfillmentType: z.nativeEnum(FulfillmentType, {
      errorMap: () => ({
        message: 'fulfillmentType must be PICKUP or DELIVERY',
      }),
    }),
    deliveryAddress: z
      .string()
      .min(5, 'Delivery address must be at least 5 characters')
      .optional(),
    notes: z.string().max(500).optional(),
  })
  .refine(
    (data) =>
      data.fulfillmentType !== FulfillmentType.DELIVERY ||
      !!data.deliveryAddress,
    {
      message: 'deliveryAddress is required for DELIVERY orders',
      path: ['deliveryAddress'],
    },
  );

export type CreateOrderDto = z.infer<typeof createOrderSchema>;

export class CreateOrderRequestDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  productId!: string;

  @ApiProperty({ example: 2, minimum: 1 })
  quantity!: number;

  @ApiProperty({ example: '+2348012345678', description: 'E.164 phone format' })
  buyerPhone!: string;

  @ApiProperty({ example: 'John Doe' })
  buyerName!: string;

  @ApiPropertyOptional({ example: 'john@example.com' })
  buyerEmail?: string;

  @ApiProperty({ enum: FulfillmentType, example: FulfillmentType.DELIVERY })
  fulfillmentType!: FulfillmentType;

  @ApiPropertyOptional({ example: '5 Broad Street, Lagos Island, Lagos' })
  deliveryAddress?: string;

  @ApiPropertyOptional({ example: 'Extra spicy please' })
  notes?: string;
}
