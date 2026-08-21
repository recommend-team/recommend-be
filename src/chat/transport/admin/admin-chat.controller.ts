import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { z } from 'zod';
import { HandoverService } from '../../engine/handover.service';
import { AdminOrderService } from '../../engine/admin-order.service';
import { AdminCatalogService } from '../../engine/admin-catalog.service';
import { ConversationService } from '../../conversation/conversation.service';
import { CurrentUser } from '../../../modules/auth/decorators/current-user.decorator';
import { Roles } from '../../../modules/auth/decorators/roles.decorator';
import { Role } from '../../../common/enums/roles.enum';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipes';

const messageSchema = z.object({
  text: z.string().min(1, 'Say something').max(2000),
});

const typingSchema = z.object({ isTyping: z.boolean() });
const orderLineSchema = z.object({
  productId: z.string().uuid('productId must be a valid UUID'),
  quantity: z
    .number({ required_error: 'Quantity is required' })
    .int('Quantity must be a whole number')
    .min(1, 'Quantity must be at least 1')
    .max(50, 'Quantity must be 50 or fewer'),
  expectedUnitPrice: z.number().nonnegative().optional(),
});

/**
 * Every buyer detail is optional: the conversation usually knows them already, and the
 * service fills the gaps from `context.profile` before refusing anything.
 */
const orderSchema = z.object({
  items: z
    .array(orderLineSchema)
    .min(1, 'Add at least one item')
    .max(50, 'Too many items in one order'),
  buyerName: z
    .string()
    .min(2, 'Buyer name must be at least 2 characters')
    .optional(),
  buyerPhone: z
    .string()
    .regex(
      /^\+[1-9]\d{7,14}$/,
      'buyerPhone must be in E.164 format (e.g. +2348012345678)',
    )
    .optional(),
  buyerEmail: z.string().email('Invalid email').optional(),
  fulfillmentType: z.enum(['PICKUP', 'DELIVERY']).optional(),
  deliveryAddress: z
    .string()
    .min(5, 'Delivery address must be at least 5 characters')
    .optional(),
  notes: z.string().max(500).optional(),

  sendToBuyer: z.boolean().optional(),
});

const areaSchema = z.object({
  areaId: z.string().uuid('areaId must be a valid UUID'),
});

class AdminMessageDto {
  text!: string;
}

class AdminAreaDto {
  areaId!: string;
}

class TypingDto {
  isTyping!: boolean;
}

class AdminOrderDto {
  items!: { productId: string; quantity: number; expectedUnitPrice?: number }[];
  buyerName?: string;
  buyerPhone?: string;
  buyerEmail?: string;
  fulfillmentType?: 'PICKUP' | 'DELIVERY';
  deliveryAddress?: string;
  notes?: string;
  sendToBuyer?: boolean;
}

@ApiTags('Admin — chat')
@ApiBearerAuth()
@Controller('admin/conversations')
@Roles(Role.ADMIN)
export class AdminChatController {
  constructor(
    private readonly handover: HandoverService,
    private readonly conversations: ConversationService,
    private readonly adminOrders: AdminOrderService,
    private readonly adminCatalog: AdminCatalogService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The queue',
    description:
      'Conversations the assistant is struggling with come first, oldest-flagged at the ' +
      'top — the buyer stuck longest is the one closest to leaving. Everything else ' +
      'follows by recency, so the same screen still works for looking something up.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Name, phone or email',
  })
  @ApiQuery({ name: 'needingAttention', required: false, example: 'true' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResponse({ status: 200, description: 'Conversations' })
  async list(
    @Query('search') search?: string,
    @Query('needingAttention') needingAttention?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const data = await this.conversations.listForAdmin({
      search,
      needingAttention: needingAttention === 'true',
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });

    return { message: 'Conversations retrieved successfully', data };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'The whole conversation',
    description:
      'Oldest first, as it would read on the buyer’s screen. `adminId` on a message says ' +
      'which person typed it — the buyer saw all of them as the assistant.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiResponse({ status: 200, description: 'Transcript' })
  @ApiResponse({ status: 404, description: 'No such conversation' })
  async transcript(@Param('id', ParseUUIDPipe) id: string) {
    const conversation = await this.conversations.findById(id);
    if (!conversation) throw new NotFoundException('Conversation not found');

    const messages = await this.conversations.getHistory(id, { limit: 200 });

    return {
      message: 'Conversation retrieved successfully',
      data: {
        ...present(conversation),
        channel: conversation.channel,
        buyerName: conversation.context?.profile?.name ?? null,
        buyerPhone: conversation.context?.profile?.phone ?? null,
        needsAttentionAt: conversation.needsAttentionAt,
        attentionReason: conversation.attentionReason,
        messages: messages.map((message) => ({
          id: message.id,
          direction: message.direction,
          author: message.author,
          adminId: message.adminId,
          text: message.text,
          payload: message.payload,
          createdAt: message.createdAt,
        })),
      },
    };
  }

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

  @Post(':id/order')
  @ApiOperation({
    summary: 'Place an order for the buyer',
    description:
      'Builds the basket on the buyer’s behalf and returns a payment link. Buyer ' +
      'details omitted from the body are taken from what the conversation already ' +
      'knows. The order is recorded against you, and is otherwise indistinguishable ' +
      'from one the buyer placed themselves.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiBody({ type: AdminOrderDto })
  @ApiResponse({ status: 201, description: 'Order placed — payment pending' })
  @ApiResponse({
    status: 400,
    description: 'Missing a buyer detail the conversation does not know either',
  })
  @ApiResponse({
    status: 409,
    description:
      'Take the conversation first, a payment is already pending on it, or the ' +
      'basket no longer matches what is on sale',
  })
  async order(
    @CurrentUser() admin: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(orderSchema)) dto: AdminOrderDto,
  ) {
    const placed = await this.adminOrders.place(id, admin.id, {
      lines: dto.items,
      buyerName: dto.buyerName,
      buyerPhone: dto.buyerPhone,
      buyerEmail: dto.buyerEmail,
      fulfillmentType: dto.fulfillmentType,
      deliveryAddress: dto.deliveryAddress,
      notes: dto.notes,
      sendToBuyer: dto.sendToBuyer,
    });

    return {
      message: placed.sent
        ? 'Order placed and the payment link sent.'
        : 'Order placed. Send the buyer the payment link.',
      data: placed,
    };
  }

  @Get(':id/catalog/areas')
  @ApiOperation({
    summary: 'Areas to order into, with the buyer’s own preselected',
    description:
      'Returns the area the conversation already believes the buyer is in, so the admin ' +
      'is usually not asked. `search` narrows the list when they are.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiQuery({ name: 'search', required: false, description: 'Area name' })
  @ApiResponse({ status: 200, description: 'Areas, and the current one' })
  async catalogAreas(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('search') search?: string,
  ) {
    const data = await this.adminCatalog.context(id, search);
    return { message: 'Areas retrieved successfully', data };
  }

  @Post(':id/area')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remember where this buyer is',
    description:
      'Stored on the conversation, not just the admin’s screen — the assistant reads the ' +
      'same field, so it stops asking a question a person has already answered.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiBody({ type: AdminAreaDto })
  @ApiResponse({ status: 200, description: 'Area remembered' })
  @ApiResponse({
    status: 404,
    description: 'No such conversation, or no such area',
  })
  async setArea(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(areaSchema)) dto: AdminAreaDto,
  ) {
    const data = await this.adminCatalog.setArea(id, dto.areaId);
    return { message: 'Area saved', data };
  }

  @Get(':id/catalog/stores')
  @ApiOperation({
    summary: 'Stores that can actually deliver to this buyer',
    description:
      'Approved vendors serving the area, open ones first. A vendor that does not serve ' +
      'it is absent rather than disabled — checkout does not validate service area, so ' +
      'anything shown here is orderable and anything orderable must be deliverable.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiQuery({
    name: 'areaId',
    required: false,
    description: 'Defaults to the buyer’s',
  })
  @ApiQuery({ name: 'search', required: false, description: 'Store name' })
  @ApiResponse({ status: 200, description: 'Stores' })
  async catalogStores(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('areaId') areaId?: string,
    @Query('search') search?: string,
  ) {
    const data = await this.adminCatalog.stores(id, { areaId, search });
    return { message: 'Stores retrieved successfully', data };
  }

  @Get(':id/catalog/products')
  @ApiOperation({
    summary: 'What a store sells, or a search across the buyer’s area',
    description:
      'Available products from approved vendors. The area filter applies to a name ' +
      'search too — knowing what you want is not a reason to reach a vendor who cannot ' +
      'deliver it.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiQuery({ name: 'vendorId', required: false })
  @ApiQuery({
    name: 'areaId',
    required: false,
    description: 'Defaults to the buyer’s',
  })
  @ApiQuery({ name: 'search', required: false, description: 'Product name' })
  @ApiResponse({ status: 200, description: 'Products' })
  async catalogProducts(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('vendorId') vendorId?: string,
    @Query('areaId') areaId?: string,
    @Query('search') search?: string,
  ) {
    const data = await this.adminCatalog.products(id, {
      areaId,
      vendorId,
      search,
    });
    return { message: 'Products retrieved successfully', data };
  }

  @Get(':id/order')
  @ApiOperation({
    summary: 'The most recent order this conversation placed',
    description:
      'Null when there has never been one. Read from the orders the conversation owns ' +
      'rather than the pending payment marker, which is cleared the moment the money ' +
      'lands — so the order stays visible as it moves from unpaid to delivered.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiResponse({ status: 200, description: 'The order, or null' })
  @ApiResponse({ status: 404, description: 'No such conversation' })
  async latestOrder(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminOrders.latestOrder(id);
    return { message: 'Order retrieved successfully', data };
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
