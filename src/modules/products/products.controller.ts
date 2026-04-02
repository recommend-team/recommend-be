import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
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
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Role } from '../../common/enums/roles.enum';
import { User } from '../auth/entities/auth.entity';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipes';
import {
  CreateProductRequestDto,
  createProductSchema,
} from './dto/create-product.dto';
import {
  UpdateProductRequestDto,
  updateProductSchema,
} from './dto/update-product.dto';

@ApiTags('Products')
@ApiBearerAuth()
@Controller('products')
@Roles(Role.SELLER)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a product',
    description:
      'Create a new product listing. Vendors are limited to 20 products total.',
  })
  @ApiBody({ type: CreateProductRequestDto })
  @ApiResponse({ status: 201, description: 'Product created' })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or product limit reached',
  })
  async create(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(createProductSchema))
    dto: CreateProductRequestDto,
  ) {
    return this.productsService.create(user.id, dto as never);
  }

  @Get()
  @ApiOperation({ summary: 'List own products (paginated)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated list of own products' })
  async findAll(
    @CurrentUser() user: User,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.productsService.findAllByVendor(user.id, {
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a product' })
  @ApiBody({ type: UpdateProductRequestDto })
  @ApiResponse({ status: 200, description: 'Product updated' })
  @ApiResponse({ status: 403, description: 'Forbidden — not your product' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateProductSchema))
    dto: UpdateProductRequestDto,
  ) {
    return this.productsService.update(user.id, id, dto as never);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a product' })
  @ApiResponse({ status: 200, description: 'Product deleted' })
  @ApiResponse({ status: 403, description: 'Forbidden — not your product' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async remove(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.productsService.remove(user.id, id);
  }
}
