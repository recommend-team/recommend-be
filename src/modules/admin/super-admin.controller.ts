import {
  Controller,
  Get,
  Post,
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
  ApiBody,
} from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../../common/enums/roles.enum';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipes';
import {
  ChangeAdminRoleSchema,
  ChangeAdminRoleSwaggerDto,
  CreateAdminSchema,
  CreateAdminSwaggerDto,
  type ChangeAdminRoleDto,
  type CreateAdminDto,
} from './dto/create-admin.dto';

@ApiTags('Super Admin')
@ApiBearerAuth()
@Controller('super-admin')
@Roles(Role.SUPER_ADMIN)
export class SuperAdminController {
  constructor(private readonly adminService: AdminService) {}

  // ─── Admin account management ───────────────────────────────────────────────

  @Post('admins')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an Admin or Customer Service account',
    description:
      '`role` is ADMIN (the default) or SUPPORT — customer service, who answer buyers ' +
      'in the chat queue and see nothing else on the admin side.',
  })
  @ApiBody({ type: CreateAdminSwaggerDto })
  @ApiResponse({ status: 201, description: 'Account created' })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  createAdmin(
    @Body(new ZodValidationPipe(CreateAdminSchema)) dto: CreateAdminDto,
  ) {
    return this.adminService.createAdmin(dto);
  }

  @Get('admins')
  @ApiOperation({ summary: 'List Admin and Customer Service accounts' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({
    name: 'role',
    required: false,
    enum: [Role.ADMIN, Role.SUPPORT],
    description: 'Only one of the two',
  })
  @ApiResponse({ status: 200, description: 'Paginated staff list' })
  getAdmins(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('role') role?: Role,
  ) {
    return this.adminService.getAdmins({ page, limit, role });
  }

  @Patch('admins/:id/role')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Make an account Admin or Customer Service',
    description: 'Applies from their next request.',
  })
  @ApiParam({ name: 'id', type: String, description: 'Admin user UUID' })
  @ApiBody({ type: ChangeAdminRoleSwaggerDto })
  @ApiResponse({ status: 200, description: 'Role changed' })
  @ApiResponse({ status: 400, description: 'Already that role' })
  @ApiResponse({ status: 404, description: 'Admin not found' })
  changeRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ChangeAdminRoleSchema)) dto: ChangeAdminRoleDto,
  ) {
    return this.adminService.changeAdminRole(id, dto.role);
  }

  @Patch('admins/:id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Let a suspended Admin or Customer Service sign in again',
  })
  @ApiParam({ name: 'id', type: String, description: 'Admin user UUID' })
  @ApiResponse({ status: 200, description: 'Active again' })
  @ApiResponse({ status: 400, description: 'Already active' })
  @ApiResponse({ status: 404, description: 'Admin not found' })
  activateAdmin(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.activateAdmin(id);
  }

  @Patch('admins/:id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend an Admin account' })
  @ApiParam({ name: 'id', type: String, description: 'Admin user UUID' })
  @ApiResponse({ status: 200, description: 'Admin suspended' })
  @ApiResponse({ status: 400, description: 'Admin already suspended' })
  @ApiResponse({ status: 404, description: 'Admin not found' })
  suspendAdmin(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.suspendAdmin(id);
  }

  // ─── Platform stats ─────────────────────────────────────────────────────────

  @Get('stats')
  @ApiOperation({ summary: 'Platform-wide statistics' })
  @ApiResponse({
    status: 200,
    description: 'Total vendors, buyers, riders, orders and revenue',
  })
  getPlatformStats() {
    return this.adminService.getPlatformStats();
  }
}
