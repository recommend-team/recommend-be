import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './entities/order.entity';
import { Checkout } from './entities/checkout.entity';
import { OrderItem } from './entities/order-item.entity';
import { Product } from '../products/entities/product.entity';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { CheckoutService } from './checkout.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { OrderLifecycleService } from './order-lifecycle.service';
import { HandoverCodeService } from './handover-code.service';
import { OrderStatusEvent } from './entities/order-status-event.entity';
import { ProductChoiceGroup } from '../products/entities/product-choice.entity';
import { PaymentsModule } from '../payments/payments.module';
import { PaymentsController } from '../payments/payments.controller';
import { WalletModule } from '../wallet/wallet.module';
import { CommonModule } from '../../common/common.module';
import { BuyerOrderEmailsListener } from './buyer-order-emails.listener';
import { StuckDeliveryService } from './stuck-delivery.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      Checkout,
      OrderItem,
      Product,
      OrderStatusEvent,
      ProductChoiceGroup,
    ]),
    PaymentsModule,
    WalletModule,
    // EmailService, for the buyer's receipt and delivery-code emails.
    CommonModule,
  ],
  controllers: [OrdersController, PaymentsController],
  providers: [
    OrdersService,
    CheckoutService,
    PaymentReconciliationService,
    OrderLifecycleService,
    HandoverCodeService,
    BuyerOrderEmailsListener,
    StuckDeliveryService,
  ],
  exports: [
    OrdersService,
    CheckoutService,
    OrderLifecycleService,
    HandoverCodeService,
  ],
})
export class OrdersModule {}
