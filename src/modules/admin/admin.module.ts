import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../auth/entities/auth.entity';
import { Product } from '../products/entities/product.entity';
import { Order } from '../orders/entities/order.entity';
import { Checkout } from '../orders/entities/checkout.entity';
import { OrderStatusEvent } from '../orders/entities/order-status-event.entity';
import { OrdersModule } from '../orders/orders.module';
import { AdminController } from './admin.controller';
import { SuperAdminController } from './super-admin.controller';
import { AdminService } from './admin.service';
import { BootstrapSuperAdminService } from './bootstrap-super-admin.service';
import { EmailService } from '../../common/services/email.service';
import { Account } from '../wallet/entities/account.entity';
import { Withdrawal } from '../wallet/entities/withdrawal.entity';
import { WalletModule } from '../wallet/wallet.module';
import { PendingUser } from '../auth/entities/pending-user.entity';
import { AuthModule } from '../auth/auth.module';
import { SellersModule } from '../sellers/sellers.module';
import { ProductsModule } from '../products/products.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { VendorAdminEdit } from './entities/vendor-admin-edit.entity';
import { AdminVendorsController } from './admin-vendors.controller';
import { AdminVendorsService } from './admin-vendors.service';

@Module({
  // OrdersModule for `confirmByReference` — the admin's "check with Paystack" must
  // settle a payment the same way the webhook and the sweep do, not its own way.
  imports: [
    TypeOrmModule.forFeature([
      User,
      Product,
      Order,
      Checkout,
      OrderStatusEvent,
      Account,
      Withdrawal,
      PendingUser,
      VendorAdminEdit,
    ]),
    OrdersModule,
    // The vendor page shows the balance, summed the one way the wallet sums it.
    WalletModule,
    // Running a vendor's account for them goes through the vendor's own code.
    AuthModule,
    SellersModule,
    ProductsModule,
    NotificationsModule,
  ],
  controllers: [AdminController, AdminVendorsController, SuperAdminController],
  providers: [
    AdminService,
    AdminVendorsService,
    BootstrapSuperAdminService,
    EmailService,
  ],
})
export class AdminModule {}
