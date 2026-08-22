import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { LocationsService } from './locations.service';
import { Public } from '../auth/decorators/public.decorator';

/**
 * Public pick-lists. The vendor dashboard uses these to render coverage selectors, and
 * the customer app uses them to resolve where a buyer is. Only active rows are returned —
 * a deactivated area stays in the database for existing vendors but is never offered.
 */
@ApiTags('Locations')
@Controller('locations')
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Get('states')
  @Public()
  @ApiOperation({
    summary: 'List active states',
    description:
      'Public endpoint — no authentication required. States are created and maintained ' +
      'by admin; nothing here is hardcoded.',
  })
  @ApiResponse({ status: 200, description: 'Active states' })
  async getStates() {
    const states = await this.locationsService.listStates();
    return { message: 'States retrieved successfully', data: states };
  }

  @Get('states/:id/areas')
  @Public()
  @ApiOperation({
    summary: 'List active areas in a state',
    description: 'Public endpoint — used for vendor coverage pick-lists.',
  })
  @ApiParam({ name: 'id', description: 'State ID' })
  @ApiResponse({ status: 200, description: 'Active areas in the state' })
  @ApiResponse({ status: 404, description: 'State not found' })
  async getAreas(@Param('id', ParseUUIDPipe) id: string) {
    const areas = await this.locationsService.listAreasByState(id);
    return { message: 'Areas retrieved successfully', data: areas };
  }
}
