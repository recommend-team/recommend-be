import { z } from 'zod';

/**
 * One cart line as a client sends it — the buyer's app at Pay, or an admin's order
 * builder. A dish built as a pack carries `packs`, `extras` and `choices`; an older
 * client's plain line carries none of them.
 *
 * Chat's own copy of the limits (PRODUCT_OPTIONS_PLAN.md) rather than the orders
 * module's: transports talk to the platform only through ports. Checkout enforces the
 * same limits again on its side.
 */
export const MAX_PORTIONS_PER_PACK = 10;
export const MAX_EXTRA_PER_PACK = 5;
export const MAX_PACKS = 50;

export const cartLineSchema = z
  .object({
    productId: z.string().uuid('productId must be a valid UUID'),
    quantity: z
      .number({ required_error: 'Quantity is required' })
      .int('Quantity must be a whole number')
      .min(1, 'Quantity must be at least 1')
      .max(50, 'Quantity must be 50 or fewer'),
    expectedUnitPrice: z.number().nonnegative().optional(),
    packs: z
      .number()
      .int()
      .min(1)
      .max(MAX_PACKS, `At most ${MAX_PACKS} packs`)
      .optional(),
    extras: z
      .array(
        z.object({
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
        }),
      )
      .max(20)
      .optional(),
    choices: z
      .array(
        z.object({
          groupId: z.string().uuid(),
          optionIds: z.array(z.string().uuid()).min(1).max(10),
        }),
      )
      .max(10)
      .optional(),
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

export type CartLineInput = z.infer<typeof cartLineSchema>;

/** Built as a pack, rather than a plain line from an older client. */
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
