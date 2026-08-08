import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiParam,
} from '@nestjs/swagger';
import { CheckoutService } from './checkout.service';
import { OrdersService } from './orders.service';
import { Public } from '../auth/decorators/public.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipes';
import {
  CreateCheckoutRequestDto,
  createCheckoutSchema,
} from './dto/create-checkout.dto';

@ApiTags('Checkout')
@Controller('checkout')
export class OrdersController {
  constructor(
    private readonly checkoutService: CheckoutService,
    private readonly ordersService: OrdersService,
  ) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check out a cart and start payment',
    description:
      'Public endpoint — no authentication required. Takes the cart the client holds ' +
      'in localStorage, **recomputes every price from the database**, and splits the ' +
      'basket into one order per vendor behind a single Paystack charge.\n\n' +
      'Items may come from several restaurants. Each vendor is credited 80% of their ' +
      'own items; the delivery fee is charged once and retained by the platform.\n\n' +
      'Nothing the client sends about price is trusted. `expectedUnitPrice` is used ' +
      'only to detect that an item changed since it was added to the cart.',
  })
  @ApiBody({ type: CreateCheckoutRequestDto })
  @ApiResponse({
    status: 200,
    description: 'Checkout created — complete payment at authorizationUrl',
    schema: {
      example: {
        success: true,
        message: 'Checkout created. Complete payment to confirm your order.',
        data: {
          checkoutId: '123e4567-e89b-12d3-a456-426614174000',
          reference: 'REC-9A3F2B7C1D4E',
          authorizationUrl: 'https://checkout.paystack.com/abc123',
          goodsTotal: 10500,
          deliveryFee: 1500,
          totalAmount: 12000,
          vendorCount: 2,
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Validation failed or cart empty' })
  @ApiResponse({
    status: 409,
    description:
      'Cart no longer matches reality — an item was removed, went unavailable, its ' +
      'vendor closed, or its price changed. The response lists what changed so the ' +
      'buyer can be shown the difference before paying.',
    schema: {
      example: {
        success: false,
        message: 'Some items changed since you added them.',
        code: 'CART_CHANGED',
        changes: [
          {
            productId: '123e4567-e89b-12d3-a456-426614174000',
            productName: 'Jollof Rice with Chicken',
            reason: 'PRICE_CHANGED',
            expectedUnitPrice: 3000,
            currentUnitPrice: 3500,
          },
        ],
      },
    },
  })
  async checkout(
    @Body(new ZodValidationPipe(createCheckoutSchema))
    dto: CreateCheckoutRequestDto,
  ) {
    const data = await this.checkoutService.createCheckout(dto as never);
    return {
      message: 'Checkout created. Complete payment to confirm your order.',
      data,
    };
  }

  @Get(':reference')
  @Public()
  @ApiOperation({
    summary: 'Order status by reference',
    description:
      'Public endpoint — the buyer already holds the reference. Returns only what ' +
      'they ordered and where it is; no contact details or address are echoed back.',
  })
  @ApiParam({ name: 'reference', example: 'REC-9A3F2B7C1D4E' })
  @ApiResponse({ status: 200, description: 'Order status' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async status(@Param('reference') reference: string) {
    const data = await this.ordersService.getCheckoutStatus(reference);
    return { message: 'Order status retrieved successfully', data };
  }
}
