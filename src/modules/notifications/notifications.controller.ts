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
  ApiQuery,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { z } from 'zod';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { User } from '../auth/entities/auth.entity';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipes';

const subscribeSchema = z.object({
  endpoint: z.string().url('endpoint must be a valid URL'),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().max(300).optional(),
});

class SubscribeRequestDto {
  endpoint!: string;
  keys!: { p256dh: string; auth: string };
  userAgent?: string;
}

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly pushService: PushService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List my notifications',
    description:
      'The durable feed. Email and web push are best-effort layers on top of this, ' +
      'so anything missed elsewhere still appears here.',
  })
  @ApiQuery({ name: 'unreadOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async list(
    @CurrentUser() user: User,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const data = await this.notificationsService.list(user.id, {
      unreadOnly: unreadOnly === 'true',
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return { message: 'Notifications retrieved successfully', data };
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Unread badge count' })
  async unreadCount(@CurrentUser() user: User) {
    const unread = await this.notificationsService.unreadCount(user.id);
    return { message: 'Unread count retrieved', data: { unread } };
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark one notification read' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 404, description: 'Not found, or not yours' })
  async markRead(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.notificationsService.markRead(user.id, id);
    return { message: 'Notification marked read', data };
  }

  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark every notification read' })
  async markAllRead(@CurrentUser() user: User) {
    const data = await this.notificationsService.markAllRead(user.id);
    return { message: 'Notifications marked read', data };
  }

  // ─── Web push ───────────────────────────────────────────────────────────────

  @Get('push/public-key')
  @Public()
  @ApiOperation({
    summary: 'VAPID public key',
    description:
      'Public by design — a browser needs this before it can subscribe. Returns null ' +
      'when push is not configured, so the client can hide the prompt.',
  })
  publicKey() {
    return {
      message: 'Public key retrieved',
      data: { publicKey: this.pushService.getPublicKey() },
    };
  }

  @Post('push/subscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Register this browser for push',
    description:
      'Idempotent — re-subscribing the same browser updates the existing row rather ' +
      'than creating a duplicate.',
  })
  @ApiBody({ type: SubscribeRequestDto })
  async subscribe(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(subscribeSchema)) dto: SubscribeRequestDto,
  ) {
    await this.pushService.subscribe({ userId: user.id, ...dto });
    return { message: 'Push subscription registered', data: null };
  }

  @Delete('push/subscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unregister this browser' })
  async unsubscribe(@Body() body: { endpoint?: string }) {
    if (body?.endpoint) await this.pushService.unsubscribe(body.endpoint);
    return { message: 'Push subscription removed', data: null };
  }
}
