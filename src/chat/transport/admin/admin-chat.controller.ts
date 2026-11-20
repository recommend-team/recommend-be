import {
  Body,
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
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
import { cartLineSchema, type CartLineInput } from '../cart-line.schema';
import { HandoverService } from '../../engine/handover.service';
import { HandlingLogService } from '../../engine/handling-log.service';
import { AdminOrderService } from '../../engine/admin-order.service';
import { AdminCatalogService } from '../../engine/admin-catalog.service';
import {
  ConversationService,
  HAS_ORDERS,
} from '../../conversation/conversation.service';
import { CurrentUser } from '../../../modules/auth/decorators/current-user.decorator';
import { Roles } from '../../../modules/auth/decorators/roles.decorator';
import { Role } from '../../../common/enums/roles.enum';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipes';
import { IDENTITY_PORT } from '../../ports/identity.port';
import type { IdentityPort } from '../../ports/identity.port';

const messageSchema = z.object({
  text: z.string().min(1, 'Say something').max(2000),
});

const typingSchema = z.object({ isTyping: z.boolean() });
/** A line of the admin's basket — packs built as a buyer builds them. */
const orderLineSchema = cartLineSchema;

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
  /** Picked from Google: the token `GET /places/resolve` gave, and the house number. */
  deliveryPlace: z
    .object({
      token: z.string().min(10).max(4000),
      details: z.string().trim().max(200).optional(),
    })
    .optional(),
  notes: z.string().max(500).optional(),

  sendToBuyer: z.boolean().optional(),
});

const deleteSchema = z.object({
  ids: z
    .array(z.string().uuid('Each id must be a valid UUID'))
    .min(1, 'Choose at least one conversation')
    .max(100, 'At most 100 at a time'),
});

const reassignSchema = z.object({
  adminId: z.string().uuid('adminId must be a valid UUID'),
});

const areaSchema = z.object({
  areaId: z.string().uuid('areaId must be a valid UUID'),
});

class AdminMessageDto {
  text!: string;
}

class DeleteConversationsDto {
  ids!: string[];
}

class ReassignDto {
  adminId!: string;
}

class AdminAreaDto {
  areaId!: string;
}

class TypingDto {
  isTyping!: boolean;
}

class AdminOrderDto {
  items!: CartLineInput[];
  buyerName?: string;
  buyerPhone?: string;
  buyerEmail?: string;
  fulfillmentType?: 'PICKUP' | 'DELIVERY';
  deliveryAddress?: string;
  deliveryPlace?: { token: string; details?: string };
  notes?: string;
  sendToBuyer?: boolean;
}

@ApiTags('Admin — chat')
@ApiBearerAuth()
@Controller('admin/conversations')
// Customer service answer buyers here; admins inherit it. Deleting and restoring stay
// with admins (`@Roles(Role.ADMIN)` on those routes).
@Roles(Role.SUPPORT)
export class AdminChatController {
  constructor(
    private readonly handover: HandoverService,
    private readonly conversations: ConversationService,
    private readonly adminOrders: AdminOrderService,
    private readonly adminCatalog: AdminCatalogService,
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    private readonly handlingLog: HandlingLogService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The inbox, or the queue',
    description:
      'Every conversation, most recent activity first. With `needingAttention=true`, ' +
      'only those waiting for a person, the longest-waiting first — the buyer stuck ' +
      'longest is the one closest to leaving. `heldByName` says which colleague has ' +
      'each chat; `waitingSince` when the buyer started waiting for a person.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Name, phone or email',
  })
  @ApiQuery({ name: 'needingAttention', required: false, example: 'true' })
  @ApiQuery({
    name: 'deleted',
    required: false,
    example: 'true',
    description:
      'The deleted conversations instead, most recently deleted first',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResponse({ status: 200, description: 'Conversations' })
  async list(
    @CurrentUser() staff: { role: Role },
    @Query('search') search?: string,
    @Query('needingAttention') needingAttention?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('deleted') deleted?: string,
  ) {
    // Deleted chats are an admin's to look through and restore.
    if (deleted === 'true' && staff.role === Role.SUPPORT) {
      throw new ForbiddenException('Only admins can see deleted conversations');
    }

    const data = await this.conversations.listForAdmin({
      search,
      needingAttention: needingAttention === 'true',
      deleted: deleted === 'true',
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    const names = await this.staffNames(
      data.items.map((item) => item.heldByAdminId),
    );

    return {
      message: 'Conversations retrieved successfully',
      data: {
        ...data,
        items: data.items.map((item) => ({
          ...item,
          heldByName: nameOf(names, item.heldByAdminId),
          waitingSince:
            item.handoverRequestedAt ?? item.needsAttentionAt ?? null,
        })),
      },
    };
  }

  @Post('delete')
  @Roles(Role.ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Delete conversations',
    description:
      'Soft: they leave the inbox and can be restored. One with orders, or a payment ' +
      'waiting, is never deleted — the buyer needs it to see and confirm them — and is ' +
      'listed under `refused` with the reason. A buyer whose chat was deleted starts a ' +
      'fresh one next time.',
  })
  @ApiBody({ type: DeleteConversationsDto })
  @ApiResponse({
    status: 200,
    description: 'What was deleted, and what was not',
  })
  async deleteMany(
    @CurrentUser() admin: { id: string },
    @Body(new ZodValidationPipe(deleteSchema)) dto: DeleteConversationsDto,
  ) {
    const data = await this.conversations.deleteForAdmin(dto.ids, admin.id);
    return {
      message:
        data.refused.length === 0
          ? `Deleted ${data.deleted.length} conversation(s).`
          : `Deleted ${data.deleted.length}; ${data.refused.length} could not be deleted.`,
      data,
    };
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Delete one conversation (soft)' })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiResponse({ status: 200, description: 'Deleted' })
  @ApiResponse({ status: 404, description: 'No such conversation' })
  @ApiResponse({
    status: 409,
    description: 'It has orders, or a payment waiting',
  })
  async deleteOne(
    @CurrentUser() admin: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const { refused } = await this.conversations.deleteForAdmin([id], admin.id);
    const reason = refused[0]?.reason;
    if (reason === HAS_ORDERS) throw new ConflictException(reason);
    if (reason) throw new NotFoundException(reason);
    return { message: 'Conversation deleted.', data: { id } };
  }

  @Post(':id/restore')
  @Roles(Role.ADMIN)
  @HttpCode(200)
  @ApiOperation({ summary: 'Bring back a deleted conversation' })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiResponse({ status: 200, description: 'Restored' })
  @ApiResponse({ status: 404, description: 'No such deleted conversation' })
  @ApiResponse({
    status: 409,
    description: 'The buyer has started a new chat since',
  })
  async restore(@Param('id', ParseUUIDPipe) id: string) {
    await this.conversations.restoreForAdmin(id);
    return { message: 'Conversation restored.', data: { id } };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'The whole conversation',
    description:
      'Oldest first, as it would read on the buyer’s screen. `adminId` and `adminName` ' +
      'on a message say which colleague typed it — the buyer saw all of them as the ' +
      'assistant.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiResponse({ status: 200, description: 'Transcript' })
  @ApiResponse({ status: 404, description: 'No such conversation' })
  async transcript(
    @CurrentUser() staff: { role: Role },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    // Deleted ones open too, read-only in the panel, so an admin can check before
    // bringing one back.
    const found = await this.conversations.findByIdIncludingDeleted(id);
    if (!found) throw new NotFoundException('Conversation not found');
    // An old link — an alert, a bookmark — to one folded into a signed-in buyer's
    // thread opens that thread. `id` in the answer says which it is.
    const conversation = await this.conversations.resolveLive(found);

    const messages = await this.conversations.getHistory(conversation.id, {
      limit: 200,
    });
    // A deleted chat is an admin's to open, like the deleted list.
    if (conversation.deletedAt && staff.role === Role.SUPPORT) {
      throw new NotFoundException('Conversation not found');
    }
    const emails = await this.conversations.verifiedEmails([conversation]);
    const names = await this.staffNames([
      conversation.heldByAdminId,
      ...messages.map((message) => message.adminId),
    ]);

    return {
      message: 'Conversation retrieved successfully',
      data: {
        ...present(conversation),
        heldByName: nameOf(names, conversation.heldByAdminId),
        channel: conversation.channel,
        buyerName: conversation.context?.profile?.name ?? null,
        buyerPhone: conversation.context?.profile?.phone ?? null,
        verifiedEmail: conversation.accountId
          ? (emails.get(conversation.accountId) ?? null)
          : null,
        needsAttentionAt: conversation.needsAttentionAt,
        attentionReason: conversation.attentionReason,
        handoverRequestedAt: conversation.handoverRequestedAt,
        handoverReason: conversation.handoverReason,
        deletedAt: conversation.deletedAt ?? null,
        messages: messages.map((message) => ({
          id: message.id,
          direction: message.direction,
          author: message.author,
          adminId: message.adminId,
          adminName: nameOf(names, message.adminId),
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
      'looking exactly like the assistant’s. First come, first served: a colleague who ' +
      'already has it keeps it.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiResponse({ status: 200, description: 'Held by you' })
  @ApiResponse({ status: 409, description: 'A colleague already has it' })
  async take(
    @CurrentUser() admin: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    try {
      const conversation = await this.handover.take(id, admin.id);
      return {
        message: 'You are now answering this conversation',
        data: present(conversation),
      };
    } catch (error) {
      // Say who, so the agent knows to leave it rather than wonder.
      if (error instanceof ConflictException) {
        const holder = await this.conversations.findById(id);
        const names = await this.staffNames([holder?.heldByAdminId]);
        const name = nameOf(names, holder?.heldByAdminId);
        if (name) {
          throw new ConflictException(
            `${name} is already answering this conversation.`,
          );
        }
      }
      throw error;
    }
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Hand it back to the assistant',
    description:
      'Sends nothing. The assistant answers the next thing the buyer says, and stays ' +
      'quiet if the conversation is over. Any checkout in progress is reset to browsing ' +
      '— the buyer’s cart is in their own browser and is not lost, and a payment already ' +
      'started still confirms. Customer service hand back their own chats; an admin can ' +
      'hand back anyone’s — for a chat left with an agent who has gone.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiResponse({ status: 200, description: 'Back with the assistant' })
  @ApiResponse({ status: 409, description: 'Held by another admin' })
  async release(
    @CurrentUser() staff: { id: string; role: Role },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const conversation = await this.handover.release(id, staff.id, {
      override: staff.role !== Role.SUPPORT,
    });
    return {
      message: 'Handed back to the assistant',
      data: present(conversation),
    };
  }

  @Post(':id/reassign')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pass a chat to a colleague',
    description:
      'For a chat stuck with someone away or overloaded. Only a chat being answered — ' +
      'one in the queue is for whoever takes it. The colleague is alerted; the buyer ' +
      'sees nothing change.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiBody({ type: ReassignDto })
  @ApiResponse({ status: 200, description: 'Passed on' })
  @ApiResponse({
    status: 400,
    description: 'Nobody has it, they already have it, or they cannot sign in',
  })
  async reassign(
    @CurrentUser() admin: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(reassignSchema)) dto: ReassignDto,
  ) {
    const colleague = await this.identity.staffMember(dto.adminId);
    if (!colleague) {
      throw new BadRequestException(
        'That person is not an active admin or customer service agent.',
      );
    }
    const conversation = await this.handover.reassign(
      id,
      colleague.id,
      admin.id,
    );
    return {
      message: `Passed to ${colleague.name}`,
      data: { ...present(conversation), heldByName: colleague.name },
    };
  }

  @Get(':id/history')
  @ApiOperation({
    summary: 'Who has answered this chat',
    description:
      'Each spell of someone holding it, first to last: when they took it, how long the ' +
      'buyer had waited, their first reply, and how it ended — handed back, passed on, ' +
      'or released for going quiet.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiResponse({ status: 200, description: 'History' })
  async history(@Param('id', ParseUUIDPipe) id: string) {
    const spells = await this.handlingLog.history(id);
    const names = await this.staffNames(
      spells.flatMap((spell) => [
        spell.adminId,
        spell.assignedByAdminId,
        spell.endedByAdminId,
      ]),
    );
    return {
      message: 'History retrieved successfully',
      data: spells.map((spell) => ({
        id: spell.id,
        adminId: spell.adminId,
        adminName: nameOf(names, spell.adminId),
        waitingSince: spell.waitingSince,
        takenAt: spell.takenAt,
        firstReplyAt: spell.firstReplyAt,
        assignedByName: nameOf(names, spell.assignedByAdminId),
        endedAt: spell.endedAt,
        endReason: spell.endReason,
        endedByName: nameOf(names, spell.endedByAdminId),
      })),
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
      deliveryPlace: dto.deliveryPlace,
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

  @Get(':id/catalog/categories')
  @ApiOperation({
    summary: 'The kinds of shop that serve this buyer',
    description:
      'Counted from the vendors themselves rather than a fixed list — `businessCategory` ' +
      'is free text. Scoped to the area, so a category with nothing nearby is never ' +
      'offered.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiQuery({
    name: 'areaId',
    required: false,
    description: 'Defaults to the buyer’s',
  })
  @ApiResponse({ status: 200, description: 'Categories with store counts' })
  async catalogCategories(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('areaId') areaId?: string,
  ) {
    const data = await this.adminCatalog.categories(id, areaId);
    return { message: 'Categories retrieved successfully', data };
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
    @Query('category') category?: string,
    @Query('search') search?: string,
  ) {
    const data = await this.adminCatalog.stores(id, {
      areaId,
      category,
      search,
    });
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
    @Query('category') category?: string,
    @Query('search') search?: string,
  ) {
    const data = await this.adminCatalog.products(id, {
      areaId,
      vendorId,
      category,
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

  /** Names never cost an answer: without them, the list still loads. */
  private staffNames(
    ids: (string | null | undefined)[],
  ): Promise<Map<string, string>> {
    return this.identity
      .staffNames(ids.filter((id): id is string => Boolean(id)))
      .catch(() => new Map<string, string>());
  }
}

function nameOf(
  names: Map<string, string>,
  adminId: string | null | undefined,
): string | null {
  return adminId ? (names.get(adminId) ?? null) : null;
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
