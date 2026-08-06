import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../auth/entities/auth.entity';
import { Order } from '../orders/entities/order.entity';
import { SellersController } from './sellers.controller';
import { SellersService } from './sellers.service';
import { LocationsModule } from '../locations/locations.module';

@Module({
  imports: [TypeOrmModule.forFeature([User, Order]), LocationsModule],
  controllers: [SellersController],
  providers: [SellersService],
  exports: [SellersService],
})
export class SellersModule {}
