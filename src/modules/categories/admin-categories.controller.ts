import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CategoriesService, type Actor } from './categories.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Role } from '../../common/enums/roles.enum';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipes';
import {
  AssignVendorsRequestDto,
  assignVendorsSchema,
  type AssignVendorsDto,
  ChangeRateRequestDto,
  CreateCategoryRequestDto,
  UpdateCategoryRequestDto,
  changeRateSchema,
  createCategorySchema,
  updateCategorySchema,
  type ChangeRateDto,
  type CreateCategoryDto,
  type UpdateCategoryDto,
} from './dto/category.dto';

/**
 * The categories Recommend offers. Any admin creates, renames and archives them and
 * edits the words buyers use for them; only the Super Admin sets what Recommend keeps.
 * Customer service have no access.
 */
@ApiTags('Admin — Categories')
@ApiBearerAuth()
@Controller('admin/categories')
@Roles(Role.ADMIN)
export class AdminCategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @ApiOperation({
    summary:
      "Every category, with Recommend's percentage and how many vendors are in it",
  })
  async list() {
    return {
      message: 'Categories retrieved',
      data: await this.categories.list(),
    };
  }

  @Get('uncategorised')
  @ApiOperation({
    summary:
      'Vendors in no category yet, each with the category their own description points at',
  })
  async uncategorised() {
    return {
      message: 'Vendors without a category retrieved',
      data: await this.categories.uncategorised(),
    };
  }

  @Post(':id/vendors')
  @ApiOperation({
    summary:
      'Put vendors in this category. Any whose rate goes up as a result are told.',
  })
  @ApiParam({ name: 'id', description: 'Category ID' })
  @ApiBody({ type: AssignVendorsRequestDto })
  async assignVendors(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(assignVendorsSchema)) dto: AssignVendorsDto,
  ) {
    return {
      message: 'Vendors moved',
      data: await this.categories.assignVendors(id, dto.vendorIds),
    };
  }

  @Post()
  @ApiOperation({
    summary:
      'Create a category. Only the Super Admin may set its percentage; otherwise it starts at the standard rate.',
  })
  @ApiBody({ type: CreateCategoryRequestDto })
  @ApiResponse({
    status: 403,
    description: 'An admin tried to set the percentage',
  })
  @ApiResponse({
    status: 409,
    description: 'The name or one of the words is taken',
  })
  async create(
    @Body(new ZodValidationPipe(createCategorySchema)) dto: CreateCategoryDto,
    @CurrentUser() admin: Actor,
  ) {
    return {
      message: 'Category created',
      data: await this.categories.create(dto, admin),
    };
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Rename, archive or restore a category, or change its words. Renaming moves its vendors with it.',
  })
  @ApiParam({ name: 'id', description: 'Category ID' })
  @ApiBody({ type: UpdateCategoryRequestDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) dto: UpdateCategoryDto,
  ) {
    return {
      message: 'Category updated',
      data: await this.categories.update(id, dto),
    };
  }

  @Patch(':id/rate')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary:
      "Change what Recommend keeps of this category's sales. Applies from the next order; logged.",
  })
  @ApiParam({ name: 'id', description: 'Category ID' })
  @ApiBody({ type: ChangeRateRequestDto })
  async changeRate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(changeRateSchema)) dto: ChangeRateDto,
    @CurrentUser() admin: Actor,
  ) {
    return {
      message: 'Rate changed',
      data: await this.categories.changeRate(id, dto, admin),
    };
  }

  @Get(':id/rate-history')
  @ApiOperation({ summary: 'Every rate this category has had, and who set it' })
  @ApiParam({ name: 'id', description: 'Category ID' })
  async rateHistory(@Param('id', ParseUUIDPipe) id: string) {
    return {
      message: 'Rate history retrieved',
      data: await this.categories.rateHistory(id),
    };
  }
}
