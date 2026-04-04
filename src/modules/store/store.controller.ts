import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { StoreService } from './store.service';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Store')
@Controller('store')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'List all approved vendor stores',
    description:
      'Public endpoint — no authentication required. Returns paginated list of approved stores with basic details.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20, max: 100)' })
  @ApiResponse({ status: 200, description: 'List of stores retrieved successfully' })
  async getAllStores(@Query('page') page?: number, @Query('limit') limit?: number) {
    return this.storeService.getAllStores(page, limit);
  }

  @Get(':slug')
  @Public()
  @ApiOperation({
    summary: 'Get public vendor storefront',
    description:
      'Public endpoint — no authentication required. Returns the vendor profile and their ' +
      'available products. Designed for the WhatsApp in-app browser storefront experience.',
  })
  @ApiParam({
    name: 'slug',
    example: 'mamas-kitchen',
    description: 'Vendor storefront slug',
  })
  @ApiResponse({ status: 200, description: 'Storefront data' })
  @ApiResponse({ status: 404, description: 'Storefront not found' })
  async getStorefront(@Param('slug') slug: string) {
    return this.storeService.getStorefront(slug);
  }
}
