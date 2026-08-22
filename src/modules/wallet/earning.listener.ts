import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { WalletService } from './wallet.service';
import {
  VENDOR_ORDER_COMPLETED_EVENT,
  VendorOrderCompletedEvent,
} from '../../common/events/vendor-order-completed.event';
import {
  WALLET_CREDITED_EVENT,
  WalletCreditedEvent,
} from '../../common/events/wallet.events';

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

  constructor(
    private readonly wallet: WalletService,
    private readonly events: EventEmitter2,
  ) {}

  @OnEvent(VENDOR_ORDER_COMPLETED_EVENT)
  async onVendorOrderCompleted(
    event: VendorOrderCompletedEvent,
  ): Promise<void> {
    try {
      const written = await this.wallet.creditEarning(event);

      if (written > 0) {
        this.events.emit(
          WALLET_CREDITED_EVENT,
          new WalletCreditedEvent(
            event.vendorId,
            event.orderId,
            event.vendorAmount,
            event.reference,
          ),
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to credit vendor ${event.vendorId} for order ${event.orderId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
