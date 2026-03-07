import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';

// PaymentsController is registered in OrdersModule to avoid circular deps
// (OrdersService ← PaymentsService, PaymentsController → both)
@Module({
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
