import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../auth/entities/auth.entity';
import { Role } from '../../common/enums/roles.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';
import { OrderStatus } from '../../common/enums/order-status.enum';

@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin')
@Roles(Role.ADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ─── Pending approvals (unified) ───────────────────────────────────────────

  @Get('pending')
  @ApiOperation({
    summary: 'Unified list of vendors + riders pending KYC approval',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({
    status: 200,
    description: 'Paginated pending approvals (vendors and riders combined)',
  })
  getPendingAll(@Query('page') page?: number, @Query('limit') limit?: number) {
    return this.adminService.getPendingAll(page, limit);
  }

  @Patch('pending/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a pending vendor or rider' })
  @ApiParam({ name: 'id', type: String, description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'User approved — email sent' })
  @ApiResponse({ status: 400, description: 'Not eligible for approval' })
  @ApiResponse({ status: 404, description: 'User not found' })
  approveUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.approveUser(id);
  }

  @Patch('pending/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a pending vendor or rider' })
  @ApiParam({ name: 'id', type: String, description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'User rejected — email sent' })
  @ApiResponse({ status: 400, description: 'Not eligible for rejection' })
  @ApiResponse({ status: 404, description: 'User not found' })
  rejectUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('reason') reason: string,
  ) {
    return this.adminService.rejectUser(id, reason ?? 'No reason provided');
  }

  // ─── Vendors ───────────────────────────────────────────────────────────────

  @Get('stores')
  @ApiOperation({
    summary: 'List all vendor stores with details and product counts',
  })
  @ApiQuery({ name: 'status', enum: SellerStatus, required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({
    status: 200,
    description: 'Paginated store list with details',
  })
  getAllStores(
    @Query('status') status?: SellerStatus,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getAllStores({ status, page, limit });
  }

  @Get('vendors')
  @ApiOperation({
    summary: 'List all vendor accounts with optional status filter',
  })
  @ApiQuery({ name: 'status', enum: SellerStatus, required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated vendor list' })
  getVendors(
    @Query('status') status?: SellerStatus,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getVendors({ status, page, limit });
  }

  @Get('vendors/:id')
  @ApiOperation({ summary: 'Get vendor detail with their products' })
  @ApiParam({ name: 'id', type: String, description: 'Vendor user UUID' })
  @ApiResponse({ status: 200, description: 'Vendor profile + products' })
  @ApiResponse({ status: 404, description: 'Vendor not found' })
  getVendorDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.getVendorDetail(id);
  }

  // ─── Buyers / Customers ─────────────────────────────────────────────────────

  @Get('buyers')
  @ApiOperation({ summary: 'List all buyer accounts' })
  @ApiQuery({ name: 'status', enum: SellerStatus, required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated buyer list' })
  getBuyers(
    @Query('status') status?: SellerStatus,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getBuyers({ status, page, limit });
  }

  @Get('buyers/:id')
  @ApiOperation({ summary: 'Get buyer detail and their order history' })
  @ApiParam({ name: 'id', type: String, description: 'Buyer user UUID' })
  @ApiResponse({ status: 200, description: 'Buyer profile + orders' })
  @ApiResponse({ status: 404, description: 'Buyer not found' })
  getBuyerDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.getBuyerDetail(id);
  }

  // ─── Products ──────────────────────────────────────────────────────────────

  @Get('products')
  @ApiOperation({
    summary: 'List all products across the platform with vendor info',
  })
  @ApiQuery({
    name: 'vendorId',
    required: false,
    type: String,
    description: 'Filter by vendor UUID',
  })
  @ApiQuery({ name: 'isAvailable', required: false, type: Boolean })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Product name, matched loosely',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({
    status: 200,
    description: 'Paginated product list with vendor info',
  })
  getAllProducts(
    @Query('vendorId') vendorId?: string,
    @Query('isAvailable') isAvailable?: string,
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const available =
      isAvailable === 'true'
        ? true
        : isAvailable === 'false'
          ? false
          : undefined;
    return this.adminService.getAllProducts({
      vendorId,
      isAvailable: available,
      search,
      page,
      limit,
    });
  }

  // ─── Orders ────────────────────────────────────────────────────────────────

  @Get('orders')
  @ApiOperation({ summary: 'List all platform orders with optional filters' })
  @ApiQuery({ name: 'status', enum: OrderStatus, required: false })
  @ApiQuery({ name: 'vendorId', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated order list' })
  getAllOrders(
    @Query('status') status?: OrderStatus,
    @Query('vendorId') vendorId?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getAllOrders({ status, vendorId, page, limit });
  }

  // ─── Transactions ──────────────────────────────────────────────────────────

  @Get('transactions')
  @ApiOperation({
    summary: 'One row per payment, with the vendor orders it covers',
    description:
      'The money view. `orders` lists each vendor’s slice of a basket, which is the ' +
      'right unit for fulfilment and the wrong one for reconciling against Paystack — ' +
      'a two-vendor basket appears there as two rows, with the delivery fee nowhere.',
  })
  @ApiQuery({ name: 'status', enum: OrderStatus, required: false })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Reference, buyer name or phone',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated transaction list' })
  getTransactions(
    @Query('status') status?: OrderStatus,
    @Query('search') search?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getTransactions({ status, search, page, limit });
  }

  @Post('transactions/:reference/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask Paystack about one transaction now',
    description:
      'For a payment a buyer is asking about, rather than waiting up to ten minutes ' +
      'for the scheduled sweep. Runs the same path every other confirmation runs, so a ' +
      'recovery here also messages the buyer and notifies the vendors.',
  })
  @ApiParam({ name: 'reference', example: 'REC-9A3F2B7C1D4E' })
  @ApiResponse({ status: 200, description: 'The transaction after checking' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  verifyTransaction(@Param('reference') reference: string) {
    return this.adminService.verifyTransaction(reference);
  }

  @Post('transactions/:reference/dispatch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'A rider has collected everything and left',
    description:
      'Checkout-level, and admin’s alone: with one rider carrying the whole basket, no ' +
      'individual vendor knows collection has finished. Requires every vendor to be ' +
      'ready first, and is what tells the buyer their order is on its way. Meaningless ' +
      'on a pickup order, which is rejected.',
  })
  @ApiParam({ name: 'reference', example: 'REC-9A3F2B7C1D4E' })
  @ApiResponse({ status: 200, description: 'Marked dispatched' })
  @ApiResponse({ status: 400, description: 'Not every vendor is ready, or it is a pickup' })
  async dispatchTransaction(
    @CurrentUser() admin: User,
    @Param('reference') reference: string,
  ) {
    return this.adminService.dispatch(reference, admin.id);
  }

  @Post('transactions/:reference/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The buyer has their order',
    description:
      'Normally the rider who handed it over, or the buyer. Admin does it on their ' +
      'behalf — there is no rider app yet, and buyers forget. Never automatic: a timer ' +
      'marking orders delivered would manufacture a record of deliveries that may never ' +
      'have happened, and that record is what vendor payouts key off.',
  })
  @ApiParam({ name: 'reference', example: 'REC-9A3F2B7C1D4E' })
  @ApiResponse({ status: 200, description: 'Marked complete' })
  async completeTransaction(
    @CurrentUser() admin: User,
    @Param('reference') reference: string,
  ) {
    return this.adminService.complete(reference, admin.id);
  }

  @Patch('transactions/:reference/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Force an order to any status',
    description:
      'The escape hatch, and admin’s alone. It exists for the orders the ordinary rules ' +
      'have stranded — a vendor who never marked ready, a rider who never reported ' +
      'back, a decline handled over the phone. Every use is written to the audit trail ' +
      'with whoever did it; `note` is worth filling in, because on an override the ' +
      'reason is the whole point.',
  })
  @ApiParam({ name: 'reference', example: 'REC-9A3F2B7C1D4E' })
  @ApiResponse({ status: 200, description: 'Status forced' })
  async overrideTransaction(
    @CurrentUser() admin: User,
    @Param('reference') reference: string,
    @Body() body: { status: OrderStatus; note?: string },
  ) {
    return this.adminService.overrideStatus(
      reference,
      body?.status,
      admin.id,
      body?.note,
    );
  }

  @Get('transactions/:reference/history')
  @ApiOperation({
    summary: 'Every status change on one order',
    description:
      'Who moved it, from what to what, when, and why. A disputed delivery with no ' +
      'history is unarguable.',
  })
  @ApiParam({ name: 'reference', example: 'REC-9A3F2B7C1D4E' })
  @ApiResponse({ status: 200, description: 'Status history, oldest first' })
  getTransactionHistory(@Param('reference') reference: string) {
    return this.adminService.getStatusHistory(reference);
  }

  // ─── General user management ───────────────────────────────────────────────

  @Get('users/:id')
  @ApiOperation({ summary: 'Get any user by ID' })
  @ApiParam({ name: 'id', type: String, description: 'User UUID' })
  @ApiResponse({ status: 200, description: 'User details' })
  @ApiResponse({ status: 404, description: 'User not found' })
  getUserById(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.getUserById(id);
  }

  @Patch('users/:id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend a vendor or buyer account' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, description: 'User suspended' })
  @ApiResponse({
    status: 400,
    description: 'User already suspended or is an admin account',
  })
  @ApiResponse({ status: 404, description: 'User not found' })
  suspendUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.suspendUser(id);
  }

  @Patch('users/:id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate a suspended vendor or buyer account' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, description: 'User activated' })
  @ApiResponse({
    status: 400,
    description: 'User already active or is an admin account',
  })
  @ApiResponse({ status: 404, description: 'User not found' })
  activateUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.activateUser(id);
  }
}
