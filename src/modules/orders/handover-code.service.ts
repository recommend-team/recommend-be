import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { timingSafeEqual } from 'crypto';
import type Redis from 'ioredis';
import { Order } from './entities/order.entity';
import { FulfillmentType } from '../../common/enums/fulfillment-type.enum';
import { liveHandoverCode } from './handover-code';

/**
 * Wrong guesses allowed per order, per window. A code is 26⁶ ≈ 309 million possibilities,
 * so ten tries cannot find one — and a vendor typing what a buyer shows them needs two.
 */
const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 15 * 60;

export interface HandoverCheck {
  matches: boolean;
  /** Who should be standing at the counter — so the vendor can see it is them. */
  buyerName: string;
  attemptsLeft: number;
}

/**
 * The counter check for a pickup: does the code the buyer is showing belong to this order?
 *
 * Only answers. It does not mark anything collected — confirming receipt stays where it
 * is, with the buyer (or admin), so a vendor checking a code cannot release their own pay.
 */
@Injectable()
export class HandoverCodeService {
  constructor(
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  async check(
    orderId: string,
    vendorId: string,
    presented: string,
  ): Promise<HandoverCheck> {
    const order = await this.orders.findOne({
      where: { id: orderId },
      relations: ['checkout'],
    });
    if (!order) throw new NotFoundException('Order not found');

    // A vendor checks codes for their own orders only, whatever the route says.
    if (order.vendorId !== vendorId) {
      throw new ForbiddenException('That order belongs to another vendor');
    }
    if (order.fulfillmentType !== FulfillmentType.PICKUP) {
      throw new BadRequestException(
        'Only pickup orders are collected at the counter — a delivery code is checked by the rider.',
      );
    }

    const live = order.checkout ? liveHandoverCode(order.checkout) : null;
    if (!live) {
      throw new BadRequestException(
        'This order is not waiting for collection — it is not ready yet, or already collected.',
      );
    }

    const key = `handover-check:${orderId}`;
    const attempts = await this.redis.incr(key);
    if (attempts === 1) await this.redis.expire(key, WINDOW_SECONDS);
    if (attempts > MAX_ATTEMPTS) {
      throw new HttpException(
        'Too many wrong codes for this order. Wait a few minutes, or ask the buyer to check the code in their Orders tab.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const normalised = presented.replace(/\s+/g, '').toUpperCase();
    const matches =
      normalised.length === live.length &&
      timingSafeEqual(Buffer.from(normalised), Buffer.from(live));

    // A right answer clears the count — the next check on this order starts fresh.
    if (matches) await this.redis.del(key);

    return {
      matches,
      buyerName: order.buyerName,
      attemptsLeft: matches ? MAX_ATTEMPTS : MAX_ATTEMPTS - attempts,
    };
  }
}
