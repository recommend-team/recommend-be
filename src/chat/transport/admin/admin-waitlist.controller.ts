import { Controller, Get, Header, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { WaitlistService } from '../../waitlist/waitlist.service';
import { Roles } from '../../../modules/auth/decorators/roles.decorator';
import { Role } from '../../../common/enums/roles.enum';

@ApiTags('Admin — chat')
@ApiBearerAuth()
@Controller('admin/waitlist')
@Roles(Role.ADMIN)
export class AdminWaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Get()
  @ApiOperation({
    summary: 'The launch waitlist',
    description:
      'Phone numbers and emails buyers left in the chat while it was paused, newest ' +
      'first, to tell them when ordering opens.',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResponse({ status: 200, description: 'Signups' })
  async list(@Query('page') page?: string, @Query('limit') limit?: string) {
    const data = await this.waitlist.list({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return { message: 'Waitlist retrieved successfully', data };
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="waitlist.csv"')
  @ApiOperation({ summary: 'Everyone on the waitlist, as CSV' })
  @ApiResponse({ status: 200, description: 'CSV: kind, contact, joinedAt' })
  async export(): Promise<string> {
    return this.waitlist.csv();
  }
}
