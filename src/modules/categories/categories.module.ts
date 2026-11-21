import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Category } from './entities/category.entity';
import { CategoryRateChange } from './entities/category-rate-change.entity';
import { User } from '../auth/entities/auth.entity';
import { CategoriesService } from './categories.service';
import { AdminCategoriesController } from './admin-categories.controller';
import { AdminVendorRatesController } from './admin-vendor-rates.controller';
import { CategoriesController } from './categories.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Category, CategoryRateChange, User])],
  controllers: [
    AdminCategoriesController,
    AdminVendorRatesController,
    CategoriesController,
  ],
  providers: [CategoriesService],
  // Checkout prices each vendor's cut with this; sign-up, Store details and admins'
  // vendor edits put vendors in categories through it.
  exports: [CategoriesService],
})
export class CategoriesModule {}
