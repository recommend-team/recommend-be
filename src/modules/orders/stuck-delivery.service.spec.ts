import { StuckDeliveryService } from './stuck-delivery.service';
import {
  DELIVERY_STUCK_EVENT,
  DeliveryStuckEvent,
} from '../../common/events/delivery-stuck.event';

describe('StuckDeliveryService', () => {
  const dispatchedAt = new Date('2026-10-17T09:00:00Z');
  let query: jest.Mock;
  let emit: jest.Mock;
  let service: StuckDeliveryService;

  beforeEach(() => {
    query = jest.fn();
    emit = jest.fn();
    service = new StuckDeliveryService(
      { query } as never,
      { get: jest.fn().mockReturnValue(3) } as never,
      { emit } as never,
    );
  });

  it('alerts each claimed delivery once, with its rider', async () => {
    query
      // The claim — TypeORM's [rows, affected] shape for an UPDATE.
      .mockResolvedValueOnce([
        [
          {
            reference: 'REC-ONE',
            buyerName: 'Ada',
            riderId: 'r1',
            dispatchedAt,
          },
          {
            reference: 'REC-TWO',
            buyerName: 'Bola',
            riderId: null,
            dispatchedAt: dispatchedAt.toISOString(),
          },
        ],
        2,
      ])
      .mockResolvedValueOnce([
        {
          id: 'r1',
          firstName: 'Tunde',
          lastName: 'Bakare',
          phoneNumber: '+2348031112222',
        },
      ]);

    await expect(service.alertStuckDeliveries()).resolves.toBe(2);

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith(
      DELIVERY_STUCK_EVENT,
      new DeliveryStuckEvent(
        'REC-ONE',
        'Ada',
        'Tunde Bakare',
        '+2348031112222',
        dispatchedAt,
      ),
    );
    expect(emit).toHaveBeenCalledWith(
      DELIVERY_STUCK_EVENT,
      new DeliveryStuckEvent('REC-TWO', 'Bola', null, null, dispatchedAt),
    );
  });

  it('claims against the stale cutoff and a recent-dispatch window', async () => {
    const now = Date.now();
    query.mockResolvedValueOnce([[], 0]);

    await service.alertStuckDeliveries();

    const [sql, [cutoff, oldest]] = query.mock.calls[0] as [
      string,
      [Date, Date],
    ];
    expect(sql).toContain(`SET "stuckAlertedAt" = now()`);
    // Alerted again only after a later dispatch.
    expect(sql).toContain(`c."stuckAlertedAt" < d."dispatchedAt"`);
    expect(now - cutoff.getTime()).toBeGreaterThanOrEqual(3 * 3_600_000);
    expect(now - cutoff.getTime()).toBeLessThan(3 * 3_600_000 + 5_000);
    expect(now - oldest.getTime()).toBeGreaterThanOrEqual(48 * 3_600_000);
    expect(emit).not.toHaveBeenCalled();
  });

  it('never throws out of the scheduler', async () => {
    query.mockRejectedValueOnce(new Error('connection lost'));

    await expect(service.alertStuckDeliveries()).resolves.toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });
});
