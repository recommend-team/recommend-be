import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { StoreService } from './store.service';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Store')
@Controller('store')
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

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
