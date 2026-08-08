import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../auth/entities/auth.entity';
import { Product } from '../products/entities/product.entity';
import { Order } from '../orders/entities/order.entity';
import { Checkout } from '../orders/entities/checkout.entity';
import { OrdersModule } from '../orders/orders.module';
import { AdminController } from './admin.controller';
import { SuperAdminController } from './super-admin.controller';
import { AdminService } from './admin.service';
import { BootstrapSuperAdminService } from './bootstrap-super-admin.service';
import { EmailService } from '../../common/services/email.service';

@Module({
  // OrdersModule for `confirmByReference` — the admin's "check with Paystack" must
  // settle a payment the same way the webhook and the sweep do, not its own way.
  imports: [
    TypeOrmModule.forFeature([User, Product, Order, Checkout]),
    OrdersModule,
  ],
  controllers: [AdminController, SuperAdminController],
  providers: [AdminService, BootstrapSuperAdminService, EmailService],
})
export class AdminModule {}
