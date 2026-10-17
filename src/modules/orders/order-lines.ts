import type { OrderItem } from './entities/order-item.entity';

/**
 * An order's rows read back as what the buyer built: each dish with its portions, its
 * choices, its extras and how many identical packs — "2 × Rice and beans (2 portions,
 * Protein: Beef, with Beef ×2, Takeaway pack ×1)".
 *
 * One reader for every place an order is shown — receipts, the vendor's alert, the chat,
 * the order page, the admin panel — so none of them rebuild packs their own way.
 */
export interface OrderLine {
  /** The dish (or plain item) as sold. */
  productName: string;
  /** "Rice and beans (2 portions, Protein: Beef, with Beef ×2)" — for one-line lists. */
  name: string;
  /**
   * How many to show beside the name: packs, for a dish built as a pack; the count, for
   * anything else. So "2 × <name>" always reads right.
   */
  quantity: number;
  /** Per pack: portions of the dish. */
  portions: number;
  packs: number;
  unit: string | null;
  /** The whole line: dish, choices and extras, all packs. */
  lineTotal: number;
  /** The line total divided by \`quantity\`, for a "₦X each" column. */
  unitPrice: number;
  isAddOn: boolean;
  choices: { group: string; option: string; priceDelta: number }[];
  /** Per pack. */
  extras: {
    name: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }[];
}

export function toOrderLines(items: OrderItem[]): OrderLine[] {
  const extrasOf = new Map<string, OrderItem[]>();
  for (const item of items) {
    if (!item.parentItemId) continue;
    extrasOf.set(item.parentItemId, [
      ...(extrasOf.get(item.parentItemId) ?? []),
      item,
    ]);
  }
  const ids = new Set(items.map((item) => item.id));

  return (
    items
      // An extra whose dish isn't in this list stands on its own, as before.
      .filter((item) => !item.parentItemId || !ids.has(item.parentItemId))
      .map((dish) => {
        const extras = extrasOf.get(dish.id) ?? [];
        const packs = dish.packs ?? 1;
        const choices = (dish.choices ?? []).map((choice) => ({
          group: choice.groupName,
          option: choice.optionName,
          priceDelta: Number(choice.priceDelta),
        }));
        const lineTotal = round2(
          Number(dish.lineTotal) +
            extras.reduce((sum, extra) => sum + Number(extra.lineTotal), 0),
        );
        const built = packs > 1 || extras.length > 0 || choices.length > 0;
        const quantity = built ? packs : dish.quantity;

        return {
          productName: dish.productName,
          name: built ? describe(dish, choices, extras) : dish.productName,
          quantity,
          portions: dish.quantity,
          packs,
          unit: dish.unit ?? null,
          lineTotal,
          unitPrice: round2(lineTotal / Math.max(1, quantity)),
          isAddOn: dish.isAddOn,
          choices,
          extras: extras.map((extra) => ({
            name: extra.productName,
            quantity: extra.quantity,
            unitPrice: Number(extra.unitPrice),
            lineTotal: Number(extra.lineTotal),
          })),
        };
      })
  );
}

/** "Rice and beans (2 portions, Protein: Beef, with Beef ×2, Takeaway pack ×1)". */
function describe(
  dish: OrderItem,
  choices: { group: string; option: string }[],
  extras: OrderItem[],
): string {
  const parts: string[] = [portionsText(dish.quantity, dish.unit)];
  const byGroup = new Map<string, string[]>();
  for (const choice of choices) {
    byGroup.set(choice.group, [
      ...(byGroup.get(choice.group) ?? []),
      choice.option,
    ]);
  }
  for (const [group, options] of byGroup) {
    parts.push(`${shortGroup(group)}: ${options.join(' & ')}`);
  }
  if (extras.length > 0) {
    parts.push(
      `with ${extras
        .map((extra) => `${extra.productName} ×${extra.quantity}`)
        .join(', ')}`,
    );
  }
  return `${dish.productName} (${parts.join(', ')})`;
}

/** "2 portions", "1 plate", or "×2" when the dish has no unit. */
function portionsText(quantity: number, unit: string | null): string {
  if (!unit) return `×${quantity}`;
  return `${quantity} ${quantity === 1 ? unit : `${unit}s`}`;
}

/** "Choose your protein" — or "Your protein" — reads as "Protein" in a one-line summary. */
function shortGroup(name: string): string {
  const trimmed = name
    .replace(/^(choose|pick|select)\s+/i, '')
    .replace(/^(your|a|an|the)\s+/i, '');
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
