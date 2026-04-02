import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { Public } from '../auth/decorators/public.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipes';
import {
  CreateOrderRequestDto,
  createOrderSchema,
} from './dto/create-order.dto';

@ApiTags('Orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Create an order and initialize payment',
    description:
      'Public endpoint — no authentication required. Buyers (via WhatsApp in-app browser) ' +
      'submit their details and the product they want. Returns a Paystack payment URL to complete purchase.',
  })
  @ApiBody({ type: CreateOrderRequestDto })
  @ApiResponse({
    status: 200,
    description: 'Order created — complete payment at authorizationUrl',
    schema: {
      example: {
        success: true,
        message: 'Order created. Complete payment to confirm your order.',
        data: {
          orderId: '123e4567-e89b-12d3-a456-426614174000',
          authorizationUrl: 'https://checkout.paystack.com/access_code',
          reference: 'REC-ABC123DEF456',
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or product unavailable',
  })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async createOrder(
    @Body(new ZodValidationPipe(createOrderSchema)) dto: CreateOrderRequestDto,
  ) {
    return this.ordersService.createOrder(dto as never);
  }
}
