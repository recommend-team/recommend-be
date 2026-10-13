import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipes';
import { ContactService } from './contact.service';
import { contactSchema, type ContactMessage } from './contact.schema';

@ApiTags('Contact')
@Controller('contact')
export class ContactController {
  constructor(private readonly contact: ContactService) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a message from the website contact form',
    description:
      'Emails the team inbox with the visitor as reply-to. Capped per sender and overall, ' +
      'per hour.',
  })
  @ApiResponse({ status: 200, description: 'Sent' })
  @ApiResponse({ status: 429, description: 'Too many messages this hour' })
  @ApiResponse({ status: 503, description: 'The email could not be sent' })
  async send(
    @Body(new ZodValidationPipe(contactSchema)) message: ContactMessage,
    @Req() request: Request,
  ) {
    await this.contact.submit(message, clientIp(request));
    return { message: 'Message sent', data: null };
  }
}

/**
 * The visitor's address. Behind Render's proxy `request.ip` is the proxy, so the first
 * X-Forwarded-For entry is used when present. It can be faked — which is why the service
 * also caps per email and overall.
 */
function clientIp(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?.split(',')[0]
    ?.trim();
  return first || request.ip || 'unknown';
}
