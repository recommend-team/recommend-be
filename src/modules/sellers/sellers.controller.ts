import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Query,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { SellersService } from './sellers.service';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Role } from '../../common/enums/roles.enum';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { User } from '../auth/entities/auth.entity';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipes';
import {
  UpdateProfileRequestDto,
  updateProfileSchema,
} from './dto/update-profile.dto';
import {
  UpdateKycRequestDto,
  updateRegisteredKycSchema,
  updateNonRegisteredKycSchema,
} from './dto/update-kyc.dto';
import {
  UpdatePayoutRequestDto,
  updatePayoutSchema,
} from './dto/update-payout.dto';
import { VendorType } from '../../common/enums/vendor-type.enum';

@ApiTags('Sellers')
@ApiBearerAuth()
@Controller('sellers')
@Roles(Role.SELLER)
export class SellersController {
  constructor(
    private readonly sellersService: SellersService,
    private readonly lifecycle: OrderLifecycleService,
  ) {}

  @Get('profile')
  @ApiOperation({
    summary: 'Get own vendor profile',
    description:
      'Returns the full vendor profile including business info, KYC status, payout details, ' +
      'storefront slug/URL, and profile completeness score.',
  })
  @ApiResponse({ status: 200, description: 'Vendor profile' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — seller role required' })
  async getProfile(@CurrentUser() user: User) {
    return this.sellersService.getProfile(user.id);
  }

  @Patch('profile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update vendor business profile',
    description:
      'Update any combination of business info, storefront images, WhatsApp number, open status, and operating hours. ' +
      'All fields are optional — only provided fields are updated. ' +
      'Setting businessName for the first time also auto-generates the storefront slug.',
  })
  @ApiBody({ type: UpdateProfileRequestDto })
  @ApiResponse({ status: 200, description: 'Profile updated' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async updateProfile(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(updateProfileSchema))
    dto: UpdateProfileRequestDto,
  ) {
    return this.sellersService.updateProfile(user.id, dto);
  }

  @Post('profile/kyc')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit KYC document URLs',
    description:
      'Submit uploaded document URLs for KYC review. Fields accepted depend on vendorType:\n' +
      '- **REGISTERED**: cacDocumentUrl, tinDocumentUrl\n' +
      '- **NON_REGISTERED**: ninDocumentUrl, passportPhotoUrl, bankStatementUrl, utilityBillUrl\n\n' +
      'Upload files first via POST /storage/upload to get the URL, then submit here.',
  })
  @ApiBody({ type: UpdateKycRequestDto })
  @ApiResponse({
    status: 200,
    description: 'KYC documents submitted for review',
  })
  @ApiResponse({
    status: 400,
    description: 'Wrong document type for your vendor type',
  })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async updateKyc(
    @CurrentUser() user: User,
    @Body() body: UpdateKycRequestDto,
  ) {
    // Pick the right schema based on the vendor's type in the JWT/profile
    const schema =
      user.vendorType === VendorType.REGISTERED
        ? updateRegisteredKycSchema
        : updateNonRegisteredKycSchema;

    const pipe = new ZodValidationPipe(schema);
    const validated = pipe.transform(body);

    return this.sellersService.updateKyc(user.id, validated as never);
  }

  @Patch('profile/payout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update bank / payout details',
    description:
      'Set the bank account details used for order payouts. All four fields are required. ' +
      'Use the Paystack bank list to get the correct bank code.',
  })
  @ApiBody({ type: UpdatePayoutRequestDto })
  @ApiResponse({ status: 200, description: 'Payout details updated' })
  @ApiResponse({
    status: 400,
    description: 'Validation failed — check account number format',
  })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async updatePayout(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(updatePayoutSchema))
    dto: UpdatePayoutRequestDto,
  ) {
    return this.sellersService.updatePayout(user.id, dto);
  }

  // ─── Orders & Earnings ──────────────────────────────────────────────────────

  @Get('orders')
  @ApiOperation({
    summary: 'List own orders (paginated)',
    description:
      "Returns orders placed on the vendor's products. Filterable by status.",
  })
  @ApiQuery({ name: 'status', required: false, enum: OrderStatus })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated order list' })
  async getOrders(
    @CurrentUser() user: User,
    @Query('status') status?: OrderStatus,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.sellersService.getOrders(user.id, {
      status,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Patch('orders/:id/ready')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark an order ready for pickup',
    description:
      'The vendor\'s only transition: "I have the goods, a rider can collect". Show it ' +
      'as **Ready for pickup**, never as Accept — a button marked Accept gets tapped ' +
      'the moment an order appears, and dispatch then sends a rider for food that is ' +
      'not cooked. Once every vendor on the basket is ready, the whole order becomes ' +
      'ready; on a pickup order that is what tells the buyer to come.',
  })
  @ApiParam({ name: 'id', description: 'Order id (this vendor’s own)' })
  @ApiResponse({ status: 200, description: 'Marked ready' })
  @ApiResponse({ status: 400, description: 'The order has not been paid for' })
  @ApiResponse({ status: 403, description: 'That order belongs to someone else' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async markOrderReady(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.lifecycle.markReady(id, user.id);
    return { message: 'Order marked ready for pickup' };
  }

  @Get('earnings')
  @ApiOperation({
    summary: 'Get earnings summary',
    description:
      'Returns total gross revenue, net revenue (after 20% platform fee), and monthly breakdown for the last 12 months.',
  })
  @ApiResponse({ status: 200, description: 'Earnings summary' })
  async getEarnings(@CurrentUser() user: User) {
    return this.sellersService.getEarnings(user.id);
  }
}
