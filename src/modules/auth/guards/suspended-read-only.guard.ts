import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ALLOW_WHEN_SUSPENDED_KEY } from '../decorators/allow-when-suspended.decorator';
import { SellerStatus } from '../../../common/enums/seller-status.enum';
import { Role } from '../../../common/enums/roles.enum';

export const SUSPENDED_MESSAGE =
  'Your account is suspended, so you can view it but not make changes. Contact Recommend to sort it out.';

/** Methods that only read. Everything else changes something. */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A suspended vendor is signed in but read-only.
 *
 * They see their orders, products, wallet and sales, and the vendor app tells them they
 * are suspended. Anything that changes something — products, store details, areas,
 * documents, payout accounts, withdrawals — is refused here, in one place, rather than
 * endpoint by endpoint: a vendor endpoint added later is covered without anyone
 * remembering to. The few writes a suspension must not block carry
 * `@AllowWhenSuspended()`.
 *
 * Only vendors: a suspended admin, rider or buyer cannot sign in at all.
 */
@Injectable()
export class SuspendedReadOnlyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const request = context
      .switchToHttp()
      .getRequest<
        Request & { user?: { role?: Role; status?: SellerStatus } }
      >();
    const user = request.user;

    if (
      !user ||
      user.role !== Role.SELLER ||
      user.status !== SellerStatus.SUSPENDED ||
      READS.has(request.method.toUpperCase())
    ) {
      return true;
    }

    const allowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_WHEN_SUSPENDED_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) return true;

    throw new ForbiddenException(SUSPENDED_MESSAGE);
  }
}
