import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { AccountsService } from './accounts.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequiresPassword } from '../auth/decorators/requires-password.decorator';
import { User } from '../auth/entities/auth.entity';
import { Role } from '../../common/enums/roles.enum';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipes';
import { Account } from './entities/account.entity';

const addSchema = z.object({
  bankCode: z.string().min(1, 'Pick a bank').max(20),
  accountNumber: z
    .string()
    .regex(/^\d{10}$/, 'Account number must be exactly 10 digits'),
  currentPassword: z.string().min(1).optional(),
});

const verifySchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'The code is six digits'),
});

class AddAccountRequestDto {
  bankCode!: string;
  accountNumber!: string;
  /** Omit if a password was confirmed in the last few minutes. */
  currentPassword?: string;
}

class VerifyAccountRequestDto {
  code!: string;
}

class RemoveAccountRequestDto {
  currentPassword?: string;
}

@ApiTags('Payout accounts')
@ApiBearerAuth()
@Controller('sellers/payout-accounts')
@Roles(Role.SELLER)
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get('/banks')
  @ApiOperation({
    summary: 'Banks that can receive a payout',
    description:
      "Paystack's own list, cached. The vendor picks from it, so an unsupported bank " +
      'cannot be entered in the first place.',
  })
  @ApiResponse({ status: 200, description: 'Supported banks' })
  async banks() {
    return {
      message: 'Banks retrieved successfully',
      data: await this.accounts.listBanks(),
    };
  }

  @Get()
  @ApiOperation({ summary: 'My payout accounts' })
  @ApiResponse({ status: 200, description: 'Accounts, default first' })
  async list(@CurrentUser() user: User) {
    const accounts = await this.accounts.list(user.id);
    return {
      message: 'Accounts retrieved successfully',
      data: accounts.map(present),
    };
  }

  @Post()
  @RequiresPassword()
  @ApiOperation({
    summary: 'Add a payout account',
    description:
      'Resolves the account with Paystack and emails a six-digit code. Nothing is saved ' +
      'if the account cannot be found at that bank. Needs the password, because adding a ' +
      'destination is how stolen sessions turn into stolen money.',
  })
  @ApiBody({ type: AddAccountRequestDto })
  @ApiResponse({ status: 201, description: 'Pending — check email for a code' })
  @ApiResponse({ status: 400, description: 'No such account at that bank' })
  @ApiResponse({ status: 401, description: 'Password required or incorrect' })
  @ApiResponse({ status: 409, description: 'Already added' })
  async add(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(addSchema)) dto: AddAccountRequestDto,
  ) {
    const account = await this.accounts.add(user, dto);
    return {
      message: 'Enter the code we emailed you to confirm this account',
      data: present(account),
    };
  }

  @Post(':id/verify')
  @ApiOperation({
    summary: 'Confirm an account with the emailed code',
    description:
      'On success the account is registered with Paystack for payouts. The account limit ' +
      'is enforced here rather than on add, so pending accounts never occupy a slot.',
  })
  @ApiParam({ name: 'id', description: 'Payout account id' })
  @ApiBody({ type: VerifyAccountRequestDto })
  @ApiResponse({ status: 200, description: 'Verified and ready for payouts' })
  @ApiResponse({ status: 400, description: 'Wrong or expired code' })
  @ApiResponse({ status: 409, description: 'Account limit reached' })
  async verify(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(verifySchema)) dto: VerifyAccountRequestDto,
  ) {
    const account = await this.accounts.verify(user, id, dto.code);
    return { message: 'Account verified', data: present(account) };
  }

  @Post(':id/resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a fresh code' })
  @ApiParam({ name: 'id', description: 'Payout account id' })
  @ApiResponse({ status: 200, description: 'Code sent' })
  @ApiResponse({ status: 400, description: 'Too soon, or already verified' })
  async resend(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.accounts.resend(user, id);
    return { message: 'Code sent' };
  }

  @Patch(':id/default')
  @ApiOperation({
    summary: 'Make this the default payout account',
    description:
      'Not password-protected: every candidate is already verified, so the worst case is ' +
      "money reaching another of the user's own accounts.",
  })
  @ApiParam({ name: 'id', description: 'Payout account id' })
  @ApiResponse({ status: 200, description: 'Default changed' })
  async setDefault(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const account = await this.accounts.setDefault(user.id, id);
    return { message: 'Default account updated', data: present(account) };
  }

  @Delete(':id')
  @RequiresPassword()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a payout account',
    description:
      'Retired rather than deleted, so past withdrawals still resolve. Needs the password: ' +
      'an attacker who can remove the real accounts can strand the owner behind their own.',
  })
  @ApiParam({ name: 'id', description: 'Payout account id' })
  @ApiBody({ type: RemoveAccountRequestDto, required: false })
  @ApiResponse({ status: 200, description: 'Removed' })
  @ApiResponse({ status: 401, description: 'Password required or incorrect' })
  async remove(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    // `currentPassword` is read off the raw body by PasswordConfirmationGuard, which runs
    // before this method — there is nothing left for the handler to validate.
    await this.accounts.remove(user, id);
    return { message: 'Account removed' };
  }
}

/** Never return the code hash, and never the full account number. */
function present(account: Account) {
  return {
    id: account.id,
    bankName: account.bankName,
    bankCode: account.bankCode,
    accountNumber: `••••${account.accountNumber.slice(-4)}`,
    accountName: account.accountName,
    status: account.status,
    isDefault: account.isDefault,
    verifiedAt: account.verifiedAt,
    createdAt: account.createdAt,
  };
}
