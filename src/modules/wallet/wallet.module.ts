import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletEntry } from './entities/wallet-entry.entity';
import { Account } from './entities/account.entity';
import { Withdrawal } from './entities/withdrawal.entity';
import { WalletService } from './wallet.service';
import { AccountsService } from './accounts.service';
import { WithdrawalsService } from './withdrawals.service';
import { WithdrawalRetryService } from './withdrawal-retry.service';
import { WalletController } from './wallet.controller';
import { AccountsController } from './accounts.controller';
import { AdminWalletController } from './admin-wallet.controller';
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
    TypeOrmModule.forFeature([WalletEntry, Account, Withdrawal]),
    PaymentsModule,
    CommonModule,
  ],
  controllers: [WalletController, AccountsController, AdminWalletController],
  providers: [
    WalletService,
    AccountsService,
    WithdrawalsService,
    WithdrawalRetryService,
    EarningListener,
  ],
  exports: [WalletService, AccountsService, WithdrawalsService],
})
export class WalletModule {}
