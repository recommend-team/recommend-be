import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletEntry } from './entities/wallet-entry.entity';
import { Account } from './entities/account.entity';
import { WalletService } from './wallet.service';
import { AccountsService } from './accounts.service';
import { WalletController } from './wallet.controller';
import { AccountsController } from './accounts.controller';
import { EarningListener } from './earning.listener';
import { PaymentsModule } from '../payments/payments.module';
import { CommonModule } from '../../common/common.module';

/**
 * The ledger, and what fills it.
 *
 * Reaches the rest of the platform only through `VENDOR_ORDER_COMPLETED` — it holds no
 * reference to the orders module, so nothing about how an order is fulfilled can reach in
 * here and move money.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([WalletEntry, Account]),
    PaymentsModule,
    CommonModule,
  ],
  controllers: [WalletController, AccountsController],
  providers: [WalletService, AccountsService, EarningListener],
  exports: [WalletService, AccountsService],
})
export class WalletModule {}
