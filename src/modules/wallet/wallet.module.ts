import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletEntry } from './entities/wallet-entry.entity';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { EarningListener } from './earning.listener';

/**
 * The ledger, and what fills it.
 *
 * Reaches the rest of the platform only through `VENDOR_ORDER_COMPLETED` — it holds no
 * reference to the orders module, so nothing about how an order is fulfilled can reach in
 * here and move money.
 */
@Module({
  imports: [TypeOrmModule.forFeature([WalletEntry])],
  controllers: [WalletController],
  providers: [WalletService, EarningListener],
  exports: [WalletService],
})
export class WalletModule {}
