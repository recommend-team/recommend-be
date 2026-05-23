import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { APPROVED_ONLY_KEY } from '../decorators/approved-only.decorator';
import { SellerStatus } from '../../../common/enums/seller-status.enum';
import { Role } from '../../../common/enums/roles.enum';

@Injectable()
export class ApprovedOnlyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(
      APPROVED_ONLY_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required) return true;

    const request = context
      .switchToHttp()
      .getRequest<
        Request & { user?: { role?: Role; status?: SellerStatus } }
      >();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    if (user.status !== SellerStatus.APPROVED) {
      throw new ForbiddenException(
        'Your account is pending KYC approval. This action becomes available once an admin approves your account.',
      );
    }

    return true;
  }
}
