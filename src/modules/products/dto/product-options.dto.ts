import { z } from 'zod';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PRODUCT_UNITS } from '../entities/product.entity';

/**
 * The parts of a product that make it a dish built the way restaurants sell it
 * (PRODUCT_OPTIONS_PLAN.md): its unit, the vendor's extras ticked onto it, and its choices.
 * Shared by create and update.
 */

export const MAX_CHOICE_GROUPS = 5;
export const MAX_CHOICE_OPTIONS = 10;
export const MAX_EXTRAS_PER_DISH = 20;

const choiceOptionSchema = z.object({
  /** Present to keep an existing option (and carts holding it); absent to add one. */
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, 'Name each option').max(60),
  /** Added per portion. ₦0 for "included". */
  priceDelta: z
    .number()
    .min(0, 'An option cannot cost less than the dish')
    .max(1_000_000)
    .multipleOf(0.01)
    .default(0),
  isAvailable: z.boolean().default(true),
});

export const choiceGroupSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z
      .string()
      .trim()
      .min(2, 'Name the choice, e.g. Choose your protein')
      .max(60),
    required: z.boolean().default(false),
    /** How many the buyer may pick. A required choice needs at least one. */
    minPick: z.number().int().min(0).max(MAX_CHOICE_OPTIONS).optional(),
    maxPick: z.number().int().min(1).max(MAX_CHOICE_OPTIONS).default(1),
    options: z
      .array(choiceOptionSchema)
      .min(1, 'Add at least one option')
      .max(MAX_CHOICE_OPTIONS, `At most ${MAX_CHOICE_OPTIONS} options`),
  })
  .transform((group) => ({
    ...group,
    // Required means at least one; optional means none is fine — unless the vendor says.
    minPick: group.minPick ?? (group.required ? 1 : 0),
  }))
  .superRefine((group, ctx) => {
    if (group.required && group.minPick < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${group.name}" is required, so the buyer must pick at least one`,
      });
    }
    if (group.minPick > group.maxPick) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${group.name}": the least to pick can't be more than the most`,
      });
    }
    if (group.maxPick > group.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${group.name}" lets the buyer pick ${group.maxPick}, but has only ${group.options.length} option(s)`,
      });
    }
  });

export const productOptionsFields = {
  unit: z.enum(PRODUCT_UNITS).nullable().optional(),
  /** The vendor's extras that go with this dish. Replaces the current list. */
  extraIds: z
    .array(z.string().uuid())
    .max(MAX_EXTRAS_PER_DISH, `At most ${MAX_EXTRAS_PER_DISH} extras on a dish`)
    .optional(),
  /**
   * An extra only: the vendor's dishes it goes on — the same links as a dish's
   * `extraIds`, set from the extra's side. Replaces the current list.
   */
  dishIds: z.array(z.string().uuid()).max(50, 'Too many dishes').optional(),
  /**
   * The dish's choices — the whole list, replacing the current one. Groups and options
   * sent with their \`id\` are kept (so carts holding them still work); those left out are
   * removed; those without an id are added.
   */
  choices: z
    .array(choiceGroupSchema)
    .max(MAX_CHOICE_GROUPS, `At most ${MAX_CHOICE_GROUPS} choices on a dish`)
    .optional(),
};

export type ChoiceGroupInput = z.infer<typeof choiceGroupSchema>;

/** Swagger only. */
export class ProductOptionsRequestDto {
  @ApiPropertyOptional({
    enum: PRODUCT_UNITS,
    example: 'portion',
    nullable: true,
  })
  unit?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description:
      'The vendor’s extras (isAddOn products) that go with this dish.',
  })
  extraIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'An extra only: the vendor’s dishes it goes on.',
  })
  dishIds?: string[];

  @ApiPropertyOptional({
    description:
      'Choices on this dish, e.g. [{ name: "Choose your protein", required: true, maxPick: 1, ' +
      'options: [{ name: "Chicken" }, { name: "Beef" }, { name: "Fish", priceDelta: 300 }] }]. ' +
      'The whole list; send ids to keep existing groups and options.',
  })
  choices?: unknown[];
}
