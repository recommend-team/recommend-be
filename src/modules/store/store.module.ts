import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../auth/entities/auth.entity';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { ProductsModule } from '../products/products.module';

@Module({
  imports: [TypeOrmModule.forFeature([User]), ProductsModule],
  controllers: [StoreController],
  providers: [StoreService],
})
export class StoreModule {}
