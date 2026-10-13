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
    summary: 'Every withdrawal, in-flight ones first',
    description:
      'Settled, failed and reversed ones too, with the vendor and the account each was ' +
      'sent to. Anything still in flight is at the top, then newest first.',
  })
  @ApiQuery({ name: 'status', required: false, enum: WithdrawalStatus })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Reference, or vendor business name, name or email',
  })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiResponse({ status: 200, description: 'A page of withdrawals' })
  async list(
    @Query('status') status?: WithdrawalStatus,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const statuses = Object.values(WithdrawalStatus) as string[];
    return {
      message: 'Withdrawals retrieved successfully',
      data: await this.withdrawals.listForAdmin({
        // An unknown status would match nothing; ignoring it shows the whole list.
        status: status && statuses.includes(status) ? status : undefined,
        search,
        page: page ? Number(page) || 1 : 1,
        limit: limit ? Number(limit) || 20 : 20,
      }),
    };
  }

  @Post('withdrawals/:id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry an in-flight withdrawal now',
    description:
      'Looks the reference up on Paystack first and sends again only if Paystack has ' +
      'nothing under it — so this cannot become a second payment.',
  })
  @ApiParam({ name: 'id', description: 'Withdrawal id' })
  @ApiResponse({ status: 200, description: 'Checked, and sent if needed' })
  @ApiResponse({
    status: 400,
    description: 'Already settled or already refunded',
  })
  async retry(@Param('id', ParseUUIDPipe) id: string) {
    const withdrawal = await this.withdrawals.retryNow(id);
    return {
      message: 'Retry attempted',
      data: { status: withdrawal.status, attempts: withdrawal.attempts },
    };
  }

  @Post('withdrawals/:id/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check a withdrawal against Paystack',
    description:
      'Asks Paystack what happened to it and corrects ours to match. One refunded by ' +
      'mistake but paid by Paystack is settled, and the refund taken back. Never sends.',
  })
  @ApiParam({ name: 'id', description: 'Withdrawal id' })
  @ApiResponse({ status: 200, description: 'Checked' })
  @ApiResponse({ status: 400, description: 'Paystack could not be reached' })
  async verify(@Param('id', ParseUUIDPipe) id: string) {
    const withdrawal = await this.withdrawals.verifyNow(id);
    return {
      message: `Checked with Paystack: ${withdrawal.status.toLowerCase()}`,
      data: { status: withdrawal.status },
    };
  }

  @Post('withdrawals/:id/fail')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Give up on a withdrawal and return the money',
    description:
      'Paystack is asked first. Refused while Paystack is still sending it; if Paystack ' +
      'paid it, it is settled instead. Otherwise the balance is credited back once.',
  })
  @ApiParam({ name: 'id', description: 'Withdrawal id' })
  @ApiBody({ type: AbandonRequestDto })
  @ApiResponse({
    status: 200,
    description: 'Failed and reversed, or found paid',
  })
  @ApiResponse({
    status: 400,
    description: 'Settled, still being sent, or Paystack could not be reached',
  })
  async abandon(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(abandonSchema)) dto: AbandonRequestDto,
  ) {
    const withdrawal = await this.withdrawals.abandon(id, dto.reason);
    return {
      message:
        withdrawal.status === WithdrawalStatus.SETTLED
          ? 'Paystack shows this withdrawal was paid, so it was marked settled and nothing was refunded'
          : 'Withdrawal failed and the balance returned',
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
