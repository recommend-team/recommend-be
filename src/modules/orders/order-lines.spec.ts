import { toOrderLines } from './order-lines';
import type { OrderItem } from './entities/order-item.entity';

const item = (over: Partial<OrderItem>): OrderItem =>
  ({
    id: 'x',
    productName: 'Item',
    unit: null,
    unitPrice: '0',
    quantity: 1,
    packs: 1,
    lineTotal: '0',
    isAddOn: false,
    parentItemId: null,
    choices: [],
    ...over,
  }) as unknown as OrderItem;

describe('toOrderLines', () => {
  it('reads a pack back whole: portions, choices, extras, and how many packs', () => {
    const [line] = toOrderLines([
      item({
        id: 'd1',
        productName: 'Rice and stew',
        unit: 'portion',
        quantity: 2,
        packs: 3,
        lineTotal: '10800' as never,
        choices: [
          {
            groupName: 'Choose your protein',
            optionName: 'Fish',
            priceDelta: '300',
          },
        ] as never,
      }),
      item({
        id: 'e1',
        productName: 'Water',
        quantity: 1,
        packs: 3,
        lineTotal: '900' as never,
        isAddOn: true,
        parentItemId: 'd1',
      }),
      item({
        id: 'e2',
        productName: 'Takeaway pack',
        quantity: 1,
        packs: 3,
        lineTotal: '600' as never,
        isAddOn: true,
        parentItemId: 'd1',
      }),
    ]);

    expect(line.name).toBe(
      'Rice and stew (2 portions, Protein: Fish, with Water ×1, Takeaway pack ×1)',
    );
    expect(line.quantity).toBe(3); // three packs — "3 × Rice and stew (…)"
    expect(line.lineTotal).toBe(12300);
    expect(line.unitPrice).toBe(4100);
    expect(line.extras.map((e) => e.name)).toEqual(['Water', 'Takeaway pack']);
  });

  it('leaves a plain item as it always read', () => {
    const [line] = toOrderLines([
      item({
        id: 'p',
        productName: 'iPhone charger',
        quantity: 3,
        lineTotal: '9000' as never,
      }),
    ]);
    expect(line).toMatchObject({
      name: 'iPhone charger',
      quantity: 3,
      lineTotal: 9000,
    });
  });

  it('shows "×2" when a dish has no unit', () => {
    const [line] = toOrderLines([
      item({
        id: 'd',
        productName: 'Suya',
        quantity: 2,
        lineTotal: '4000' as never,
      }),
      item({
        id: 'e',
        productName: 'Onions',
        quantity: 1,
        parentItemId: 'd',
        lineTotal: '0' as never,
      }),
    ]);
    expect(line.name).toBe('Suya (×2, with Onions ×1)');
  });

  it('keeps an extra whose dish isn’t in the list as its own line', () => {
    const lines = toOrderLines([
      item({
        id: 'e',
        productName: 'Water',
        parentItemId: 'elsewhere',
        lineTotal: '300' as never,
      }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].name).toBe('Water');
  });
});
