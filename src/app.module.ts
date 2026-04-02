import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bull';
import { AppConfigModule } from './config/config.module';
import { RedisModule } from './common/redis/redis.module';
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './config/database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { AdminModule } from './modules/admin/admin.module';
import { SellersModule } from './modules/sellers/sellers.module';
import { StorageModule } from './modules/storage/storage.module';
import { ProductsModule } from './modules/products/products.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { StoreModule } from './modules/store/store.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    RedisModule,
    CommonModule,
    AuthModule,
    AdminModule,
    SellersModule,
    StorageModule,
    ProductsModule,
    OrdersModule,
    PaymentsModule,
    StoreModule,
    BullModule.forRoot({
      redis: {
        host: 'localhost',
        port: 6379,
      },
    }),
    ThrottlerModule.forRoot({
      ttl: 60,
      limit: 100,
    }),
    ScheduleModule.forRoot(),
  ],
  providers: [
    // Global JWT guard — all routes are protected by default; use @Public() to opt out
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Global roles guard — enforces @Roles() decorator
    { provide: APP_GUARD, useClass: RolesGuard },
    // Global response interceptor — wraps all success responses
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    // Global exception filter — standardises all error responses
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
