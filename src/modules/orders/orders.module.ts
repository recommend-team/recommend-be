import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './entities/order.entity';
import { Product } from '../products/entities/product.entity';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PaymentsModule } from '../payments/payments.module';
import { PaymentsController } from '../payments/payments.controller';

// PaymentsController lives here (not PaymentsModule) to avoid circular deps:
//   OrdersService → PaymentsService (via PaymentsModule)
//   PaymentsController → OrdersService + PaymentsService (both available here)
@Module({
  imports: [TypeOrmModule.forFeature([Order, Product]), PaymentsModule],
  controllers: [OrdersController, PaymentsController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
