import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminVendorsService } from './admin-vendors.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipes';
import {
  adminUpdateVendorSchema,
  changeVendorEmailSchema,
  createVendorSchema,
  type AdminUpdateVendorDto,
  type ChangeVendorEmailDto,
  type CreateVendorDto,
} from './dto/admin-vendor.dto';
import {
  createProductSchema,
  type CreateProductDto,
} from '../products/dto/create-product.dto';
import {
  updateProductSchema,
  type UpdateProductDto,
} from '../products/dto/update-product.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../auth/entities/auth.entity';
import { Role } from '../../common/enums/roles.enum';

/**
 * An admin running a vendor's account for them — set up, store, owner, areas, open or
 * closed, products, documents, and removal. Never money: payout accounts, withdrawals and
 * the wallet stay with the vendor (and the existing wallet tools).
 *
 * Listing and viewing vendors stays on `AdminController` (`GET /admin/vendors`,
 * `GET /admin/vendors/:id`); suspending and reactivating on `/admin/users/:id/...`.
 */
@ApiTags('Admin — vendors')
@ApiBearerAuth()
@Controller('admin/vendors')
@Roles(Role.ADMIN)
export class AdminVendorsController {
  constructor(private readonly vendors: AdminVendorsService) {}

  @Post()
  @ApiOperation({
    summary: 'Set up a vendor',
    description:
      'For someone onboarded in person. Approved and open straight away, with a shop link. ' +
      'They have no password: they are emailed a link (72 hours) to choose one.',
  })
  @ApiResponse({ status: 201, description: 'Vendor created' })
  @ApiResponse({ status: 409, description: 'Email or phone already in use' })
  create(
    @CurrentUser() admin: User,
    @Body(new ZodValidationPipe(createVendorSchema)) dto: CreateVendorDto,
  ) {
    return this.vendors.createVendor(admin.id, dto);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change a vendor’s store and owner details',
    description:
      'Any store field the vendor can change (name, category, description, address, ' +
      'WhatsApp, logo, banner, opening hours, open/closed, areaIds), plus firstName, ' +
      'lastName, phoneNumber, vendorType and orderQuota. Logged, and the vendor is told.',
  })
  update(
    @CurrentUser() admin: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(adminUpdateVendorSchema))
    dto: AdminUpdateVendorDto,
  ) {
    return this.vendors.updateVendor(admin.id, id, dto);
  }

  @Patch(':id/email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change a vendor’s login email',
    description: 'The old address is emailed that it changed.',
  })
  changeEmail(
    @CurrentUser() admin: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(changeVendorEmailSchema))
    dto: ChangeVendorEmailDto,
  ) {
    return this.vendors.changeEmail(admin.id, id, dto.email);
  }

  @Post(':id/invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Email a link to set their password',
    description:
      'The invite again for a vendor who never set a password, or a fresh link for one ' +
      'who is locked out. Valid 72 hours.',
  })
  invite(@CurrentUser() admin: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.vendors.sendInvite(admin.id, id);
  }

  @Post(':id/kyc')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Attach KYC documents',
    description:
      'Uploaded document URLs (POST /storage/upload first). REGISTERED: cacDocumentUrl, ' +
      'tinDocumentUrl. NON_REGISTERED: ninDocumentUrl, passportPhotoUrl, ' +
      'bankStatementUrl, utilityBillUrl.',
  })
  kyc(
    @CurrentUser() admin: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.vendors.updateKyc(admin.id, id, body);
  }

  @Patch(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a vendor (deactivate)',
    description:
      'Cannot sign in, hidden from buyers, shop link closed. Orders and ledger are kept. ' +
      'Undo with PATCH /admin/users/:id/activate.',
  })
  deactivate(
    @CurrentUser() admin: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { reason?: string } = {},
  ) {
    return this.vendors.deactivate(
      admin.id,
      id,
      typeof body?.reason === 'string' ? body.reason : undefined,
    );
  }

  @Get(':id/history')
  @ApiOperation({ summary: 'What admins have changed on this vendor' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  history(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    return this.vendors.history(id, limit ? parseInt(limit, 10) : undefined);
  }

  // ─── Products ──────────────────────────────────────────────────────────────

  @Get(':id/products')
  @ApiOperation({ summary: 'A vendor’s products (paginated)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  products(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.vendors.listProducts(
      id,
      page ? parseInt(page, 10) : undefined,
      limit ? parseInt(limit, 10) : undefined,
    );
  }

  @Post(':id/products')
  @ApiOperation({
    summary: 'Add a product for a vendor',
    description: 'Same fields and 20-product limit as the vendor app.',
  })
  addProduct(
    @CurrentUser() admin: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createProductSchema)) dto: CreateProductDto,
  ) {
    return this.vendors.addProduct(admin.id, id, dto);
  }

  @Patch(':id/products/:productId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change a vendor’s product (incl. available)' })
  updateProduct(
    @CurrentUser() admin: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body(new ZodValidationPipe(updateProductSchema)) dto: UpdateProductDto,
  ) {
    return this.vendors.updateProduct(admin.id, id, productId, dto);
  }

  @Delete(':id/products/:productId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a vendor’s product' })
  removeProduct(
    @CurrentUser() admin: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.vendors.removeProduct(admin.id, id, productId);
  }
}
