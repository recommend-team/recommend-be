import { Module } from '@nestjs/common';
import { CategoriesModule } from '../categories/categories.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../auth/entities/auth.entity';
import { Order } from '../orders/entities/order.entity';
import { SellersController } from './sellers.controller';
import { SellersService } from './sellers.service';
import { OrdersModule } from '../orders/orders.module';
import { LocationsModule } from '../locations/locations.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Order]),
    LocationsModule,
    OrdersModule,
    // Which category a vendor is in, and what Recommend keeps of their sales.
    CategoriesModule,
  ],
  controllers: [SellersController],
  providers: [SellersService],
  exports: [SellersService],
})
export class SellersModule {}
