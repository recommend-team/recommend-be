import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { Checkout } from './entities/checkout.entity';
import {
  DELIVERY_STUCK_EVENT,
  DeliveryStuckEvent,
} from '../../common/events/delivery-stuck.event';

/**
 * Only orders dispatched this recently are alerted. Older ones still show under "Stuck on
 * its way" on the transactions page; this keeps a first deploy from paging admins about
 * every forgotten test order at once.
 */
const ALERT_WINDOW_HOURS = 48;

/**
 * When the order last left with a rider: its latest move to DISPATCHED, or — for orders
 * dispatched before status events were kept — when the rider was assigned.
 */
export const DISPATCHED_AT_SQL = (alias: string) =>
  `COALESCE((SELECT MAX(e."createdAt") FROM order_status_events e
              WHERE e."checkoutId" = ${alias}.id AND e."toStatus" = 'DISPATCHED'),
            ${alias}."riderAssignedAt")`;

@Injectable()
export class StuckDeliveryService {
  private readonly logger = new Logger(StuckDeliveryService.name);

  constructor(
    @InjectRepository(Checkout)
    private readonly checkouts: Repository<Checkout>,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async alertStuckDeliveries(): Promise<number> {
    const staleHours = this.config.get<number>('delivery.staleHours') ?? 3;
    const now = Date.now();
    const cutoff = new Date(now - staleHours * 60 * 60_000);
    const oldest = new Date(now - ALERT_WINDOW_HOURS * 60 * 60_000);

    let claimed: ClaimedDelivery[];
    try {
      const raw: unknown = await this.checkouts.query(
        `UPDATE checkouts c
            SET "stuckAlertedAt" = now()
           FROM (SELECT c2.id, ${DISPATCHED_AT_SQL('c2')} AS "dispatchedAt"
                   FROM checkouts c2
                  WHERE c2.status = 'DISPATCHED') d
          WHERE c.id = d.id
            AND c.status = 'DISPATCHED'
            AND d."dispatchedAt" <= $1
            AND d."dispatchedAt" > $2
            AND (c."stuckAlertedAt" IS NULL OR c."stuckAlertedAt" < d."dispatchedAt")
        RETURNING c.reference, c."buyerName", c."riderId", d."dispatchedAt"`,
        [cutoff, oldest],
      );
      // TypeORM hands back [rows, affected] for an UPDATE, and plain rows elsewhere.
      const rows = (
        Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw
      ) as ClaimedDelivery[];
      claimed = Array.isArray(rows) ? rows : [];
    } catch (error) {
      this.logger.error(
        `Could not look for stuck deliveries: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return 0;
    }

    if (claimed.length === 0) return 0;

    const riders = await this.ridersOf(claimed);
    for (const delivery of claimed) {
      const rider = delivery.riderId ? riders.get(delivery.riderId) : undefined;
      this.events.emit(
        DELIVERY_STUCK_EVENT,
        new DeliveryStuckEvent(
          delivery.reference,
          delivery.buyerName,
          rider?.name ?? null,
          rider?.phone ?? null,
          new Date(delivery.dispatchedAt),
        ),
      );
      this.logger.warn(
        `Order ${delivery.reference} has been on its way for over ${staleHours}h — admins alerted`,
      );
    }
    return claimed.length;
  }

  private async ridersOf(
    claimed: ClaimedDelivery[],
  ): Promise<Map<string, { name: string; phone: string | null }>> {
    const ids = [
      ...new Set(claimed.map((row) => row.riderId).filter(Boolean)),
    ] as string[];
    if (ids.length === 0) return new Map();
    const rows = (await this.checkouts
      .query(
        `SELECT id, "firstName", "lastName", "phoneNumber" FROM users WHERE id = ANY($1::uuid[])`,
        [ids],
      )
      .catch(() => [])) as {
      id: string;
      firstName: string | null;
      lastName: string | null;
      phoneNumber: string | null;
    }[];
    return new Map(
      rows.map((row) => [
        row.id,
        {
          name: `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim(),
          phone: row.phoneNumber,
        },
      ]),
    );
  }
}

interface ClaimedDelivery {
  reference: string;
  buyerName: string;
  riderId: string | null;
  dispatchedAt: Date | string;
}
