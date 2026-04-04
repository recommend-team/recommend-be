import {
  Controller,
  Get,
  Patch,
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
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({
    status: 200,
    description: 'Paginated product list with vendor info',
  })
  getAllProducts(
    @Query('vendorId') vendorId?: string,
    @Query('isAvailable') isAvailable?: string,
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
