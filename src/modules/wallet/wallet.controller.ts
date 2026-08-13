import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { WalletService } from './wallet.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { User } from '../auth/entities/auth.entity';
import { Role } from '../../common/enums/roles.enum';

const MAX_PAGE_SIZE = 100;

@ApiTags('Wallet')
@ApiBearerAuth()
@Controller('sellers/wallet')
@Roles(Role.SELLER)
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

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
}

function clamp(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}
