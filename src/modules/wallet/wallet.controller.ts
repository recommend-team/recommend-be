import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { z } from 'zod';
import { WalletService } from './wallet.service';
import { WithdrawalsService } from './withdrawals.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ApprovedOnly } from '../auth/decorators/approved-only.decorator';
import { RequiresPassword } from '../auth/decorators/requires-password.decorator';
import { User } from '../auth/entities/auth.entity';
import { Role } from '../../common/enums/roles.enum';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipes';

const MAX_PAGE_SIZE = 100;

const withdrawSchema = z.object({
  accountId: z.string().uuid('Choose a payout account'),
  amount: z.number().positive('Enter an amount to withdraw'),
  currentPassword: z.string().min(1).optional(),
});

class WithdrawRequestDto {
  accountId!: string;
  amount!: number;
  /** Omit if a password was confirmed in the last few minutes. */
  currentPassword?: string;
}

@ApiTags('Wallet')
@ApiBearerAuth()
@Controller('sellers/wallet')
@Roles(Role.SELLER)
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly withdrawals: WithdrawalsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'My wallet balance',
    description:
      'Summed from the ledger on every call rather than stored, so the figure and the ' +
      'statement below it can never disagree. Earnings appear when a buyer confirms they ' +
      'received the order, not when they pay.',
  })
  @ApiResponse({ status: 200, description: 'Balance and entry count' })
  async getWallet(@CurrentUser() user: User) {
    const summary = await this.wallet.summaryOf(user.id);
    return {
      message: 'Wallet retrieved successfully',
      data: { currency: 'NGN', ...summary },
    };
  }

  @Get('entries')
  @ApiOperation({
    summary: 'My statement',
    description:
      'Every movement, newest first. A sale appears as two lines — what was sold, and ' +
      'the commission charged on it — so the balance is always explicable.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiResponse({ status: 200, description: 'Ledger entries' })
  async getEntries(
    @CurrentUser() user: User,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const { entries, total } = await this.wallet.entriesOf(user.id, {
      limit: clamp(limit, 20, MAX_PAGE_SIZE),
      offset: Math.max(0, Number(offset) || 0),
    });

    return {
      message: 'Entries retrieved successfully',
      data: entries,
      meta: { total },
    };
  }

  @Get('withdrawals')
  @ApiOperation({ summary: 'My withdrawals, newest first' })
  @ApiResponse({ status: 200, description: 'Withdrawals' })
  async listWithdrawals(@CurrentUser() user: User) {
    return {
      message: 'Withdrawals retrieved successfully',
      data: await this.withdrawals.list(user.id),
    };
  }

  @Get('withdrawals/quote')
  @ApiOperation({
    summary: 'What a withdrawal of this amount would send',
    description:
      'The fee is deducted, not absorbed. Showing it before the vendor confirms is what ' +
      'makes deducting acceptable — the complaint is never the fee, it is the surprise.',
  })
  @ApiQuery({ name: 'amount', example: 4800 })
  @ApiResponse({ status: 200, description: 'Amount, fee, and what arrives' })
  quote(@Query('amount') amount: string) {
    return {
      message: 'Quote retrieved successfully',
      data: this.withdrawals.quote(Number(amount) || 0),
    };
  }

  @Post('withdrawals')
  @ApprovedOnly()
  @RequiresPassword()
  @ApiOperation({
    summary: 'Withdraw to a payout account',
    description:
      'Debited at request, not at settlement, so two requests moments apart cannot both ' +
      'spend the same balance. If our Paystack balance has not settled yet the transfer ' +
      'is queued and retried — the vendor is told it is on its way, which is true.',
  })
  @ApiBody({ type: WithdrawRequestDto })
  @ApiResponse({ status: 201, description: 'Accepted and on its way' })
  @ApiResponse({
    status: 400,
    description: 'Below the minimum, or more than the balance',
  })
  @ApiResponse({ status: 401, description: 'Password required or incorrect' })
  @ApiResponse({ status: 403, description: 'KYC not approved' })
  async withdraw(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(withdrawSchema)) dto: WithdrawRequestDto,
  ) {
    const withdrawal = await this.withdrawals.request(
      user,
      dto.accountId,
      dto.amount,
    );

    return {
      message: 'Withdrawal on its way',
      data: {
        id: withdrawal.id,
        reference: withdrawal.reference,
        amountRequested: Number(withdrawal.amountRequested),
        feeAmount: Number(withdrawal.feeAmount),
        amountSent: Number(withdrawal.amountSent),
        status: withdrawal.status,
        createdAt: withdrawal.createdAt,
      },
    };
  }
}

function clamp(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}
