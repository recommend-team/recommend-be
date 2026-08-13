import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WalletService } from './wallet.service';
import {
  VENDOR_ORDER_COMPLETED_EVENT,
  VendorOrderCompletedEvent,
} from '../../common/events/vendor-order-completed.event';

/**
 * A delivered order becomes money a vendor can see.
 *
 * Deliberately on receipt rather than on payment: there is no vendor decline path and no
 * refund path, so crediting at payment would pay for orders that may never be fulfilled,
 * with nothing to claw the money back with.
 */
@Injectable()
export class EarningListener {
  private readonly logger = new Logger(EarningListener.name);

  constructor(private readonly wallet: WalletService) {}

  @OnEvent(VENDOR_ORDER_COMPLETED_EVENT)
  async onVendorOrderCompleted(
    event: VendorOrderCompletedEvent,
  ): Promise<void> {
    try {
      await this.wallet.creditEarning(event);
    } catch (error) {
      // Never rethrow: the delivery happened, and unwinding it because the bookkeeping
      // failed would be the worse outcome. The entry is recoverable — its key is derived
      // from the order id, so replaying this event credits exactly once whenever it runs.
      this.logger.error(
        `Failed to credit vendor ${event.vendorId} for order ${event.orderId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
