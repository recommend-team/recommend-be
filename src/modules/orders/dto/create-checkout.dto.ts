import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FulfillmentType } from '../../../common/enums/fulfillment-type.enum';

export const checkoutLineSchema = z.object({
  productId: z.string().uuid('productId must be a valid UUID'),
  quantity: z
    .number({ required_error: 'Quantity is required' })
    .int('Quantity must be a whole number')
    .min(1, 'Quantity must be at least 1')
    .max(50, 'Quantity must be 50 or fewer'),
  /**
   * What the client last saw this item cost. Optional, and never used for pricing —
   * the server always recomputes from the database. Supplying it only lets us tell
   * the buyer "this changed since you added it" instead of silently charging a
   * different amount.
   */
  expectedUnitPrice: z.number().nonnegative().optional(),
});

export const createCheckoutSchema = z
  .object({
    items: z
      .array(checkoutLineSchema)
      .min(1, 'Your cart is empty')
      .max(50, 'Too many items in one order'),
    buyerName: z.string().min(2, 'Buyer name must be at least 2 characters'),
    buyerPhone: z
      .string()
      .regex(
        /^\+[1-9]\d{7,14}$/,
        'buyerPhone must be in E.164 format (e.g. +2348012345678)',
      ),
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

export type CreateCheckoutDto = z.infer<typeof createCheckoutSchema>;
export type CheckoutLineDto = z.infer<typeof checkoutLineSchema>;

class CheckoutLineRequestDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  productId!: string;

  @ApiProperty({ example: 2, minimum: 1, maximum: 50 })
  quantity!: number;

  @ApiPropertyOptional({
    example: 3500,
    description:
      'Price the client last displayed. Optional. Never used for pricing — only to ' +
      'detect that an item changed since it was added to the cart.',
  })
  expectedUnitPrice?: number;
}

export class CreateCheckoutRequestDto {
  @ApiProperty({
    type: [CheckoutLineRequestDto],
    description:
      'The cart. Items may come from several vendors — the platform splits them into ' +
      'one order per vendor behind a single payment.',
  })
  items!: CheckoutLineRequestDto[];

  @ApiProperty({ example: 'Ada Obi' })
  buyerName!: string;

  @ApiProperty({ example: '+2348012345678', description: 'E.164 phone format' })
  buyerPhone!: string;

  @ApiPropertyOptional({ example: 'ada@example.com' })
  buyerEmail?: string;

  @ApiProperty({ enum: FulfillmentType, example: FulfillmentType.DELIVERY })
  fulfillmentType!: FulfillmentType;

  @ApiPropertyOptional({ example: '12 Herbert Macaulay Way, Yaba, Lagos' })
  deliveryAddress?: string;

  @ApiPropertyOptional({ example: 'Extra spicy please' })
  notes?: string;
}
