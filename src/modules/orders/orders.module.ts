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
import { OrderStatusEvent } from './entities/order-status-event.entity';
import { PaymentsModule } from '../payments/payments.module';
import { PaymentsController } from '../payments/payments.controller';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      Checkout,
      OrderItem,
      Product,
      OrderStatusEvent,
    ]),
    PaymentsModule,
    WalletModule,
  ],
  controllers: [OrdersController, PaymentsController],
  providers: [
    OrdersService,
    CheckoutService,
    PaymentReconciliationService,
    OrderLifecycleService,
  ],
  exports: [OrdersService, CheckoutService, OrderLifecycleService],
})
export class OrdersModule {}
