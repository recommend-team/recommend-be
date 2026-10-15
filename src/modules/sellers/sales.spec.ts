import { SellersService } from './sellers.service';
import { OrderStatus } from '../../common/enums/order-status.enum';

describe("a vendor's sales", () => {
  const salesCountedFor = async () => {
    const where: { sql: string; params: Record<string, unknown> }[] = [];
    const builder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn(function (
        this: unknown,
        sql: string,
        params: Record<string, unknown>,
      ) {
        where.push({ sql, params });
        return this;
      }),
      andWhere: jest.fn(function (
        this: unknown,
        sql: string,
        params: Record<string, unknown> = {},
      ) {
        where.push({ sql, params });
        return this;
      }),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    const service = new SellersService(
      {} as never,
      { createQueryBuilder: jest.fn(() => builder) } as never,
      {} as never,
    );

    await service.getSales('v1');
    return where.find((w) => w.sql.includes('status IN'))?.params
      .statuses as OrderStatus[];
  };

  it('still counts an order once the vendor marks it ready, and while it is on its way', async () => {
    const statuses = await salesCountedFor();

    expect(statuses).toEqual(
      expect.arrayContaining([
        OrderStatus.PAID,
        OrderStatus.READY,
        OrderStatus.DISPATCHED,
        OrderStatus.COMPLETED,
      ]),
    );
  });

  it('never counts an unpaid, cancelled or refunded order', async () => {
    const statuses = await salesCountedFor();

    expect(statuses).not.toContain(OrderStatus.PENDING_PAYMENT);
    expect(statuses).not.toContain(OrderStatus.CANCELLED);
    expect(statuses).not.toContain(OrderStatus.REFUNDED);
  });
});
