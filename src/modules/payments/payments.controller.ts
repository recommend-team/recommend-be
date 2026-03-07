import {
  Controller,
  Post,
  Req,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { PaymentsService } from './payments.service';
import { OrdersService } from '../orders/orders.service';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly ordersService: OrdersService,
  ) {}

  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Paystack webhook endpoint',
    description:
      'Receives and verifies Paystack events. ' +
      'Processes charge.success to mark orders as paid. ' +
      'Signature verification uses HMAC-SHA512 with the Paystack secret key.',
  })
  @ApiResponse({ status: 200, description: 'Webhook processed' })
  @ApiResponse({ status: 400, description: 'Invalid signature or payload' })
  async handleWebhook(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    @Req() req: any,
    @Headers('x-paystack-signature') signature: string,
  ) {
    if (!signature) {
      throw new BadRequestException('Missing x-paystack-signature header');
    }

    // rawBody is attached by NestFactory.create with { rawBody: true }
    const typedReq = req as { rawBody?: Buffer; body?: unknown };
    const rawBody: Buffer =
      typedReq.rawBody ?? Buffer.from(JSON.stringify(typedReq.body ?? {}));

    let event: string;
    let data: Record<string, unknown>;

    try {
      ({ event, data } = this.paymentsService.parseWebhook(rawBody, signature));
    } catch {
      throw new BadRequestException('Invalid webhook signature');
    }

    this.logger.log(`Paystack webhook received: ${event}`);

    if (event === 'charge.success') {
      const reference = data['reference'] as string | undefined;
      if (reference) {
        await this.ordersService.handlePaymentSuccess(reference);
      }
    }

    // Always return 200 so Paystack doesn't retry
    return { received: true };
  }
}
