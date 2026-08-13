import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { WalletService } from './wallet.service';
import { WithdrawalsService } from './withdrawals.service';
import { WithdrawalStatus } from './entities/withdrawal.entity';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { User } from '../auth/entities/auth.entity';
import { Role } from '../../common/enums/roles.enum';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipes';

const adjustSchema = z.object({
  amount: z
    .number()
    .refine((value) => value !== 0, 'An adjustment of zero changes nothing'),
  note: z.string().min(5, 'Say why — an unexplained adjustment is unauditable'),
});

const abandonSchema = z.object({
  reason: z.string().min(5, 'Say why this withdrawal is being given up on'),
});

class AdjustRequestDto {
  /** Signed: positive credits the user, negative debits them. */
  amount!: number;
  note!: string;
}

class AbandonRequestDto {
  reason!: string;
}

/**
 * Admin's view of the money.
 */
@ApiTags('Admin — wallet')
@ApiBearerAuth()
@Controller('admin')
@Roles(Role.ADMIN)
export class AdminWalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly withdrawals: WithdrawalsService,
  ) {}

  @Get('withdrawals')
  @ApiOperation({
    summary: 'Withdrawals, stuck ones first',
    description:
      'Ordered so that anything still in flight, longest since its last attempt, is at ' +
      'the top — which is the only reason to open this list.',
  })
  @ApiQuery({ name: 'status', required: false, enum: WithdrawalStatus })
  @ApiResponse({ status: 200, description: 'Withdrawals' })
  async list(@Query('status') status?: WithdrawalStatus) {
    return {
      message: 'Withdrawals retrieved successfully',
      data: await this.withdrawals.listForAdmin(status),
    };
  }

  @Post('withdrawals/:id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry a withdrawal now',
    description:
      'Sends again on the same reference, which Paystack deduplicates — so this cannot ' +
      'become a second payment even if the first is still in flight.',
  })
  @ApiParam({ name: 'id', description: 'Withdrawal id' })
  @ApiResponse({ status: 200, description: 'Attempted' })
  @ApiResponse({
    status: 400,
    description: 'Already settled or already failed',
  })
  async retry(@Param('id', ParseUUIDPipe) id: string) {
    const withdrawal = await this.withdrawals.retryNow(id);
    return {
      message: 'Retry attempted',
      data: { status: withdrawal.status, attempts: withdrawal.attempts },
    };
  }

  @Post('withdrawals/:id/fail')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Give up on a withdrawal and return the money',
    description:
      'The balance is credited back exactly once, whatever else has already tried to ' +
      'fail it. Refused for one that has settled — the bank has that money.',
  })
  @ApiParam({ name: 'id', description: 'Withdrawal id' })
  @ApiBody({ type: AbandonRequestDto })
  @ApiResponse({ status: 200, description: 'Failed and reversed' })
  async abandon(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(abandonSchema)) dto: AbandonRequestDto,
  ) {
    const withdrawal = await this.withdrawals.abandon(id, dto.reason);
    return {
      message: 'Withdrawal failed and the balance returned',
      data: { status: withdrawal.status },
    };
  }

  @Get('wallet/:userId/entries')
  @ApiOperation({
    summary: "Someone's statement",
    description:
      'Every movement, so any balance can be explained from the ledger alone rather ' +
      'than reconstructed from orders.',
  })
  @ApiParam({ name: 'userId' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiResponse({ status: 200, description: 'Entries and balance' })
  async entries(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const [summary, page] = await Promise.all([
      this.wallet.summaryOf(userId),
      this.wallet.entriesOf(userId, {
        limit: Math.min(Number(limit) || 50, 200),
        offset: Math.max(0, Number(offset) || 0),
      }),
    ]);

    return {
      message: 'Entries retrieved successfully',
      data: page.entries,
      meta: { total: page.total, ...summary },
    };
  }

  @Post('wallet/:userId/adjust')
  @ApiOperation({
    summary: 'Correct a balance, on the record',
    description:
      'A new entry, never an edit — the balance stays derivable and the correction stays ' +
      'visible. The note is required because an unexplained adjustment is unauditable.',
  })
  @ApiParam({ name: 'userId' })
  @ApiBody({ type: AdjustRequestDto })
  @ApiResponse({ status: 201, description: 'Adjusted' })
  async adjust(
    @CurrentUser() admin: User,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(new ZodValidationPipe(adjustSchema)) dto: AdjustRequestDto,
  ) {
    const entry = await this.wallet.adjust({
      userId,
      amount: dto.amount,
      note: dto.note,
      adminId: admin.id,
    });

    return {
      message: 'Balance adjusted',
      data: { entryId: entry.id, balance: await this.wallet.balanceOf(userId) },
    };
  }
}
