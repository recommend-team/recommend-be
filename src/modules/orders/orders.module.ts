import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './entities/order.entity';
import { Checkout } from './entities/checkout.entity';
import { OrderItem } from './entities/order-item.entity';
import { Product } from '../products/entities/product.entity';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { CheckoutService } from './checkout.service';
import { PaymentsModule } from '../payments/payments.module';
import { PaymentsController } from '../payments/payments.controller';

// PaymentsController lives here (not PaymentsModule) to avoid circular deps:
//   OrdersService → PaymentsService (via PaymentsModule)
//   PaymentsController → OrdersService + PaymentsService (both available here)
@Module({
  imports: [
    TypeOrmModule.forFeature([Order, Checkout, OrderItem, Product]),
    PaymentsModule,
  ],
  controllers: [OrdersController, PaymentsController],
  providers: [OrdersService, CheckoutService],
  exports: [OrdersService, CheckoutService],
})
export class OrdersModule {}
