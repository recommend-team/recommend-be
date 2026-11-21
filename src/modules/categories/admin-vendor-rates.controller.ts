import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CategoriesService, type Actor } from './categories.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Role } from '../../common/enums/roles.enum';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipes';
import {
  VendorRateRequestDto,
  vendorRateSchema,
  type VendorRateDto,
} from './dto/category.dto';

/**
 * What Recommend keeps of one vendor's sales. Admins see it and its history; only the
 * Super Admin agrees a rate of the vendor's own, or removes it.
 */
@ApiTags('Admin — Vendor rates')
@ApiBearerAuth()
@Controller('admin/vendors')
@Roles(Role.ADMIN)
export class AdminVendorRatesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get(':id/rate')
  @ApiOperation({
    summary:
      "This vendor's rate, where it comes from, and every rate of their own they have had",
  })
  @ApiParam({ name: 'id', description: 'Vendor ID' })
  async rate(@Param('id', ParseUUIDPipe) id: string) {
    const [rate, history] = await Promise.all([
      this.categories.vendorRate(id),
      this.categories.vendorRateHistory(id),
    ]);
    return { message: 'Rate retrieved', data: { ...rate, history } };
  }

  @Patch(':id/rate')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary:
      "Set this vendor's own rate, or null to go back to their category's. Applies from the next order; logged.",
  })
  @ApiParam({ name: 'id', description: 'Vendor ID' })
  @ApiBody({ type: VendorRateRequestDto })
  async setRate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(vendorRateSchema)) dto: VendorRateDto,
    @CurrentUser() admin: Actor,
  ) {
    return {
      message: 'Rate changed',
      data: await this.categories.setVendorRate(id, dto.feePercent, admin),
    };
  }
}
