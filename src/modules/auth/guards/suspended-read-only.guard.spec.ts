import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  SUSPENDED_MESSAGE,
  SuspendedReadOnlyGuard,
} from './suspended-read-only.guard';
import { User } from '../entities/auth.entity';
import { Role } from '../../../common/enums/roles.enum';
import { SellerStatus } from '../../../common/enums/seller-status.enum';

function contextFor(
  method: string,
  user: { role: Role; status: SellerStatus } | undefined,
): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ method, user }) }),
  } as unknown as ExecutionContext;
}

describe('SuspendedReadOnlyGuard', () => {
  const reflector = new Reflector();
  const guard = new SuspendedReadOnlyGuard(reflector);
  const suspended = { role: Role.SELLER, status: SellerStatus.SUSPENDED };

  afterEach(() => jest.restoreAllMocks());

  it('lets a suspended vendor read anything', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(guard.canActivate(contextFor(method, suspended))).toBe(true);
    }
  });

  it('refuses every change a suspended vendor tries', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(() => guard.canActivate(contextFor(method, suspended))).toThrow(
        new ForbiddenException(SUSPENDED_MESSAGE),
      );
    }
  });

  it('allows the writes marked as allowed — finishing paid orders, signing out', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    expect(guard.canActivate(contextFor('PATCH', suspended))).toBe(true);
  });

  it('leaves everyone else alone', () => {
    const others = [
      { role: Role.SELLER, status: SellerStatus.APPROVED },
      { role: Role.SELLER, status: SellerStatus.PENDING },
      { role: Role.ADMIN, status: SellerStatus.APPROVED },
    ];
    for (const user of others) {
      expect(guard.canActivate(contextFor('POST', user))).toBe(true);
    }
    expect(guard.canActivate(contextFor('POST', undefined))).toBe(true);
  });
});

describe('who can hold a session', () => {
  const user = (role: Role, status: SellerStatus) =>
    Object.assign(new User(), {
      role,
      status,
      isEmailVerified: true,
      failedLoginAttempts: 0,
    });

  it('keeps a suspended vendor signed in — read-only, not locked out', () => {
    expect(user(Role.SELLER, SellerStatus.SUSPENDED).canHoldSession()).toBe(
      true,
    );
    expect(user(Role.SELLER, SellerStatus.SUSPENDED).canLogin()).toBe(true);
  });

  it('still keeps out a deactivated vendor, and anyone else suspended', () => {
    expect(user(Role.SELLER, SellerStatus.DEACTIVATED).canHoldSession()).toBe(
      false,
    );
    expect(user(Role.ADMIN, SellerStatus.SUSPENDED).canHoldSession()).toBe(
      false,
    );
    expect(user(Role.RIDER, SellerStatus.SUSPENDED).canHoldSession()).toBe(
      false,
    );
  });

  it('does not count a suspended vendor as active (alerts, approvals)', () => {
    expect(user(Role.SELLER, SellerStatus.SUSPENDED).isActive()).toBe(false);
  });
});
