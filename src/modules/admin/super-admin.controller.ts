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
  CreateAdminSchema,
  CreateAdminSwaggerDto,
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
  @ApiOperation({ summary: 'Create a new Admin account' })
  @ApiBody({ type: CreateAdminSwaggerDto })
  @ApiResponse({ status: 201, description: 'Admin account created' })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  createAdmin(
    @Body(new ZodValidationPipe(CreateAdminSchema)) dto: CreateAdminSwaggerDto,
  ) {
    return this.adminService.createAdmin(dto);
  }

  @Get('admins')
  @ApiOperation({ summary: 'List all Admin accounts' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated admin list' })
  getAdmins(@Query('page') page?: number, @Query('limit') limit?: number) {
    return this.adminService.getAdmins({ page, limit });
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
