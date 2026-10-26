import { z } from 'zod';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FulfillmentType } from '../../../common/enums/fulfillment-type.enum';

/** Limits on one pack (PRODUCT_OPTIONS_PLAN.md). */
export const MAX_PORTIONS_PER_PACK = 10;
export const MAX_EXTRA_PER_PACK = 5;

/** An extra added to a dish: how many in each pack. */
export const checkoutExtraSchema = z.object({
  productId: z.string().uuid('productId must be a valid UUID'),
  quantity: z
    .number()
    .int()
    .min(1)
    .max(
      MAX_EXTRA_PER_PACK,
      `At most ${MAX_EXTRA_PER_PACK} of each extra in a pack`,
    ),
  expectedUnitPrice: z.number().nonnegative().optional(),
});

/** What the buyer picked for one of the dish's choices. */
export const checkoutChoiceSchema = z.object({
  groupId: z.string().uuid(),
  optionIds: z.array(z.string().uuid()).min(1).max(10),
});

export const checkoutLineSchema = z
  .object({
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
    /**
     * A dish built as a pack: `quantity` is portions per pack, `packs` how many identical
     * packs, `extras` and `choices` what goes in each. Omitted by older clients, whose
     * lines are read the old way (extras as their own lines, attached to a dish).
     */
    packs: z.number().int().min(1).max(50, 'At most 50 packs').optional(),
    extras: z.array(checkoutExtraSchema).max(20).optional(),
    choices: z.array(checkoutChoiceSchema).max(10).optional(),
  })
  .superRefine((line, ctx) => {
    if (isPackLine(line) && line.quantity > MAX_PORTIONS_PER_PACK) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quantity'],
        message: `At most ${MAX_PORTIONS_PER_PACK} portions in a pack`,
      });
    }
  });

/** Built as a pack (the new shape), rather than a plain line from an older client. */
export function isPackLine(line: {
  packs?: number;
  extras?: unknown[];
  choices?: unknown[];
}): boolean {
  return (
    line.packs !== undefined ||
    (line.extras?.length ?? 0) > 0 ||
    (line.choices?.length ?? 0) > 0
  );
}

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
    /**
     * The address, picked from Google Places: the token `GET /places/resolve` gave, and
     * what Google can't know — the house or flat number, a landmark. Used instead of
     * `deliveryAddress`, which stays for an address typed by hand.
     */
    deliveryPlace: z
      .object({
        token: z.string().min(10).max(4000),
        details: z.string().trim().max(200).optional(),
      })
      .optional(),
    notes: z.string().max(500).optional(),
    /**
     * The area the delivery goes to, from the vendor's own areas. Required for a
     * storefront delivery, so a buyer outside them is told before paying, not after.
     */
    areaId: z.string().uuid('areaId must be a valid UUID').optional(),
  })
  .refine(
    (data) =>
      data.fulfillmentType !== FulfillmentType.DELIVERY ||
      !!data.deliveryAddress ||
      !!data.deliveryPlace,
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

  @ApiPropertyOptional({
    description:
      'Picked from Google: { token } from GET /places/resolve, and optional details — house number, landmark',
  })
  deliveryPlace?: { token: string; details?: string };

  @ApiPropertyOptional({ example: 'Extra spicy please' })
  notes?: string;

  @ApiPropertyOptional({
    example: '0536c260-0497-4ed7-90ca-179ee12ce90e',
    description:
      'Where the delivery goes, from the vendor’s service areas (GET /store/:slug). ' +
      'Required for a delivery from the storefront.',
  })
  areaId?: string;
}
