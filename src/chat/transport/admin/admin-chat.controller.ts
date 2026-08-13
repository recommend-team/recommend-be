import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiParam,
} from '@nestjs/swagger';
import { z } from 'zod';
import { HandoverService } from '../../engine/handover.service';
import { CurrentUser } from '../../../modules/auth/decorators/current-user.decorator';
import { Roles } from '../../../modules/auth/decorators/roles.decorator';
import { Role } from '../../../common/enums/roles.enum';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipes';

const messageSchema = z.object({
  text: z.string().min(1, 'Say something').max(2000),
});

const typingSchema = z.object({ isTyping: z.boolean() });

class AdminMessageDto {
  text!: string;
}

class TypingDto {
  isTyping!: boolean;
}

/**
 * An admin answering a buyer directly.
 *
 * Lives in `src/chat/transport/` rather than `src/modules/admin/` because of the boundary
 * rule in `src/chat/README.md`: nothing outside this folder may import from inside it.
 * That is not a technicality here — an admin in a conversation is a *participant*, and
 * participants belong to the transport layer next to the PWA gateway, not to the module
 * that manages vendors and money.
 *
 * The decorators are the one permitted crossing in the other direction: auth is the
 * platform's, and reimplementing it here would be worse than importing it.
 */
@ApiTags('Admin — chat')
@ApiBearerAuth()
@Controller('admin/conversations')
@Roles(Role.ADMIN)
export class AdminChatController {
  constructor(private readonly handover: HandoverService) {}

  @Post(':id/take')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Answer this conversation yourself',
    description:
      'The assistant stops replying immediately. Buyer messages are still recorded — ' +
      'they are simply left for you. The buyer is not told, and your replies reach them ' +
      'looking exactly like the assistant’s.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiResponse({ status: 200, description: 'Held by you' })
  @ApiResponse({ status: 409, description: 'Another admin already holds it' })
  async take(
    @CurrentUser() admin: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const conversation = await this.handover.take(id, admin.id);
    return {
      message: 'You are now answering this conversation',
      data: present(conversation),
    };
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Hand it back to the assistant',
    description:
      'Sends nothing. The assistant answers the next thing the buyer says, and stays ' +
      'quiet if the conversation is over. Any checkout in progress is reset to browsing ' +
      '— the buyer’s cart is in their own browser and is not lost, and a payment already ' +
      'started still confirms.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiResponse({ status: 200, description: 'Back with the assistant' })
  @ApiResponse({ status: 409, description: 'Held by another admin' })
  async release(
    @CurrentUser() admin: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const conversation = await this.handover.release(id, admin.id);
    return {
      message: 'Handed back to the assistant',
      data: present(conversation),
    };
  }

  @Post(':id/messages')
  @ApiOperation({
    summary: 'Reply to the buyer',
    description:
      'Delivered exactly as an assistant message. Recorded with your id so the ' +
      'transcript knows who typed it, while the buyer sees no difference.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiBody({ type: AdminMessageDto })
  @ApiResponse({ status: 201, description: 'Sent' })
  @ApiResponse({ status: 409, description: 'Take the conversation first' })
  async send(
    @CurrentUser() admin: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(messageSchema)) dto: AdminMessageDto,
  ) {
    const sent = await this.handover.send(id, admin.id, dto.text);
    return { message: 'Sent', data: sent };
  }

  @Post(':id/typing')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Show the buyer that someone is composing',
    description:
      'A buyer who believes they are talking to software will wait through "typing…" ' +
      'and will not wait through silence. Best-effort, like every other send.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiBody({ type: TypingDto })
  async typing(
    @CurrentUser() admin: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(typingSchema)) dto: TypingDto,
  ) {
    await this.handover.setTyping(id, admin.id, dto.isTyping);
  }
}

function present(conversation: {
  id: string;
  state: string;
  heldByAdminId: string | null;
  heldAt: Date | null;
  lastAdminMessageAt: Date | null;
}) {
  return {
    id: conversation.id,
    state: conversation.state,
    heldByAdminId: conversation.heldByAdminId,
    heldAt: conversation.heldAt,
    lastAdminMessageAt: conversation.lastAdminMessageAt,
  };
}
