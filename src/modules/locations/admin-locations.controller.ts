import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
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
import { LocationsService } from './locations.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../../common/enums/roles.enum';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipes';
import {
  CreateAreaRequestDto,
  CreateStateRequestDto,
  UpdateAreaRequestDto,
  UpdateStateRequestDto,
  createAreaSchema,
  createStateSchema,
  updateAreaSchema,
  updateStateSchema,
} from './dto/location.dto';

/**
 * Admin ownership of the location list.
 *
 * Deleting is deliberately awkward: `DELETE` only succeeds when nothing references the
 * row, and otherwise returns 409 telling you how many vendors would have been affected.
 * Deactivation is the intended way to retire a location.
 */
@ApiTags('Admin — Locations')
@ApiBearerAuth()
@Controller('admin/locations')
@Roles(Role.ADMIN)
export class AdminLocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  // ─── States ─────────────────────────────────────────────────────────────────

  @Get('states')
  @ApiOperation({ summary: 'List all states, including deactivated ones' })
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  async listStates(@Query('includeInactive') includeInactive?: string) {
    const states = await this.locationsService.listStates(
      includeInactive !== 'false',
    );
    return { message: 'States retrieved successfully', data: states };
  }

  @Post('states')
  @ApiOperation({ summary: 'Create a state' })
  @ApiBody({ type: CreateStateRequestDto })
  @ApiResponse({ status: 201, description: 'State created' })
  @ApiResponse({ status: 409, description: 'A state with that name exists' })
  async createState(
    @Body(new ZodValidationPipe(createStateSchema))
    dto: CreateStateRequestDto,
  ) {
    const state = await this.locationsService.createState(dto);
    return { message: 'State created successfully', data: state };
  }

  @Patch('states/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a state' })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: UpdateStateRequestDto })
  async updateState(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateStateSchema))
    dto: UpdateStateRequestDto,
  ) {
    const state = await this.locationsService.updateState(id, dto);
    return { message: 'State updated successfully', data: state };
  }

  @Patch('states/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate a state',
    description:
      'Takes the state and everything under it out of circulation without destroying ' +
      'anything. This is the intended way to retire a location.',
  })
  @ApiParam({ name: 'id' })
  async deactivateState(@Param('id', ParseUUIDPipe) id: string) {
    const state = await this.locationsService.setStateActive(id, false);
    return { message: 'State deactivated', data: state };
  }

  @Patch('states/:id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate a state' })
  @ApiParam({ name: 'id' })
  async activateState(@Param('id', ParseUUIDPipe) id: string) {
    const state = await this.locationsService.setStateActive(id, true);
    return { message: 'State activated', data: state };
  }

  @Delete('states/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Permanently delete a state',
    description:
      'Only succeeds when the state has no areas. Otherwise deactivate it.',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 409, description: 'State still has areas' })
  async deleteState(@Param('id', ParseUUIDPipe) id: string) {
    return this.locationsService.deleteState(id);
  }

  // ─── Areas ──────────────────────────────────────────────────────────────────

  @Get('states/:id/areas')
  @ApiOperation({
    summary: 'List all areas in a state, including deactivated ones',
  })
  @ApiParam({ name: 'id', description: 'State ID' })
  async listAreas(@Param('id', ParseUUIDPipe) id: string) {
    const areas = await this.locationsService.listAreasByState(id, true);
    return { message: 'Areas retrieved successfully', data: areas };
  }

  @Post('areas')
  @ApiOperation({ summary: 'Create an area' })
  @ApiBody({ type: CreateAreaRequestDto })
  @ApiResponse({
    status: 409,
    description: 'That area already exists in the state',
  })
  async createArea(
    @Body(new ZodValidationPipe(createAreaSchema)) dto: CreateAreaRequestDto,
  ) {
    const area = await this.locationsService.createArea(dto);
    return { message: 'Area created successfully', data: area };
  }

  @Patch('areas/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update an area' })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: UpdateAreaRequestDto })
  async updateArea(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateAreaSchema)) dto: UpdateAreaRequestDto,
  ) {
    const area = await this.locationsService.updateArea(id, dto);
    return { message: 'Area updated successfully', data: area };
  }

  @Get('areas/:id/vendor-count')
  @ApiOperation({
    summary: 'How many vendors serve this area',
    description:
      'Check before deactivating, so the impact is visible up front.',
  })
  @ApiParam({ name: 'id' })
  async vendorCount(@Param('id', ParseUUIDPipe) id: string) {
    const count = await this.locationsService.countVendorsServingArea(id);
    return { message: 'Vendor count retrieved', data: { areaId: id, count } };
  }

  @Patch('areas/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate an area' })
  @ApiParam({ name: 'id' })
  async deactivateArea(@Param('id', ParseUUIDPipe) id: string) {
    const area = await this.locationsService.setAreaActive(id, false);
    return { message: 'Area deactivated', data: area };
  }

  @Patch('areas/:id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate an area' })
  @ApiParam({ name: 'id' })
  async activateArea(@Param('id', ParseUUIDPipe) id: string) {
    const area = await this.locationsService.setAreaActive(id, true);
    return { message: 'Area activated', data: area };
  }

  @Delete('areas/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Permanently delete an area',
    description:
      'Only succeeds when no vendor serves it. Otherwise deactivate it.',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 409, description: 'Vendors still serve this area' })
  async deleteArea(@Param('id', ParseUUIDPipe) id: string) {
    return this.locationsService.deleteArea(id);
  }

  // ─── Backfill cleanup ───────────────────────────────────────────────────────

  @Get('unmapped')
  @ApiOperation({
    summary: 'Vendor coverage the migration could not map to an area',
    description:
      'Free-text values from the old businessAreas column that matched no area. Create ' +
      'the missing area, re-link the vendor, then mark the entry resolved.',
  })
  @ApiQuery({ name: 'includeResolved', required: false, type: Boolean })
  async listUnmapped(@Query('includeResolved') includeResolved?: string) {
    const rows = await this.locationsService.listUnmappedAreas(
      includeResolved === 'true',
    );
    return { message: 'Unmapped areas retrieved', data: rows };
  }

  @Patch('unmapped/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark an unmapped entry as dealt with' })
  @ApiParam({ name: 'id' })
  async resolveUnmapped(@Param('id', ParseUUIDPipe) id: string) {
    return this.locationsService.resolveUnmapped(id);
  }
}
