import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { Role } from '../../../common/enums/roles.enum';
import { AdminChatController } from '../../../chat/transport/admin/admin-chat.controller';
import { AdminController } from '../../admin/admin.controller';
import { AdminVendorsController } from '../../admin/admin-vendors.controller';
import { AdminKycController } from '../../admin/admin-kyc.controller';
import { AdminWalletController } from '../../wallet/admin-wallet.controller';
import { AdminLocationsController } from '../../locations/admin-locations.controller';
import { SuperAdminController } from '../../admin/super-admin.controller';
import { SupportTeamController } from '../../../chat/transport/admin/support-team.controller';
import { AdminCategoriesController } from '../../categories/admin-categories.controller';
import { AdminVendorRatesController } from '../../categories/admin-vendor-rates.controller';
import { Roles } from '../decorators/roles.decorator';

/** A stand-in for any @Roles(Role.SELLER) route. */
@Roles(Role.SELLER)
class SellerOnly {
  handle(): void {}
}

type Handler = (...args: never[]) => unknown;

/** Would someone with `role` get past the guard on this controller method? */
function allowed(
  role: Role,
  controller: { prototype: object },
  method: string,
): boolean {
  const handler = (controller.prototype as Record<string, Handler>)[method];
  const context = {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;

  try {
    return new RolesGuard(new Reflector()).canActivate(context);
  } catch (error) {
    if (error instanceof ForbiddenException) return false;
    throw error;
  }
}

describe('Customer service (SUPPORT) access', () => {
  it.each([
    'list',
    'transcript',
    'take',
    'release',
    'send',
    'order',
    'latestOrder',
    'catalogProducts',
    'typing',
  ])('can %s in the chat queue', (method) => {
    expect(allowed(Role.SUPPORT, AdminChatController, method)).toBe(true);
  });

  it('can read who has answered a chat', () => {
    expect(allowed(Role.SUPPORT, AdminChatController, 'history')).toBe(true);
  });

  it('cannot pass a chat to a colleague, or see the team figures — admins do that', () => {
    expect(allowed(Role.SUPPORT, AdminChatController, 'reassign')).toBe(false);
    expect(allowed(Role.ADMIN, AdminChatController, 'reassign')).toBe(true);
    expect(allowed(Role.SUPPORT, SupportTeamController, 'team')).toBe(false);
    expect(allowed(Role.ADMIN, SupportTeamController, 'team')).toBe(true);
  });

  it.each(['deleteMany', 'deleteOne', 'restore'])(
    'cannot %s conversations — that stays with admins',
    (method) => {
      expect(allowed(Role.SUPPORT, AdminChatController, method)).toBe(false);
      expect(allowed(Role.ADMIN, AdminChatController, method)).toBe(true);
    },
  );

  it('still lets admins and the super admin answer chats', () => {
    expect(allowed(Role.ADMIN, AdminChatController, 'take')).toBe(true);
    expect(allowed(Role.SUPER_ADMIN, AdminChatController, 'take')).toBe(true);
  });

  it.each([
    [AdminController, 'approveUser'],
    [AdminVendorsController, 'update'],
    [
      AdminKycController,
      Object.getOwnPropertyNames(AdminKycController.prototype)[1],
    ],
    [
      AdminWalletController,
      Object.getOwnPropertyNames(AdminWalletController.prototype)[1],
    ],
    [
      AdminLocationsController,
      Object.getOwnPropertyNames(AdminLocationsController.prototype)[1],
    ],
    [SuperAdminController, 'createAdmin'],
  ] as [{ prototype: object; name: string }, string][])(
    'is kept out of %p',
    (controller, method) => {
      expect(allowed(Role.SUPPORT, controller, method)).toBe(false);
    },
  );

  it('is never a vendor or rider', () => {
    expect(allowed(Role.SUPPORT, SellerOnly, 'handle')).toBe(false);
  });
});

describe('Categories', () => {
  it.each([
    'list',
    'create',
    'update',
    'rateHistory',
    'uncategorised',
    'assignVendors',
  ])('any admin can %s', (method) => {
    expect(allowed(Role.ADMIN, AdminCategoriesController, method)).toBe(true);
    expect(allowed(Role.SUPER_ADMIN, AdminCategoriesController, method)).toBe(
      true,
    );
  });

  it("only the Super Admin changes Recommend's percentage", () => {
    expect(
      allowed(Role.SUPER_ADMIN, AdminCategoriesController, 'changeRate'),
    ).toBe(true);
    expect(allowed(Role.ADMIN, AdminCategoriesController, 'changeRate')).toBe(
      false,
    );
  });

  it('is closed to customer service and vendors', () => {
    for (const method of ['list', 'create', 'update', 'changeRate']) {
      expect(allowed(Role.SUPPORT, AdminCategoriesController, method)).toBe(
        false,
      );
      expect(allowed(Role.SELLER, AdminCategoriesController, method)).toBe(
        false,
      );
    }
  });
});

describe("A vendor's own rate", () => {
  it('any admin can see it; only the Super Admin sets it', () => {
    expect(allowed(Role.ADMIN, AdminVendorRatesController, 'rate')).toBe(true);
    expect(allowed(Role.ADMIN, AdminVendorRatesController, 'setRate')).toBe(
      false,
    );
    expect(
      allowed(Role.SUPER_ADMIN, AdminVendorRatesController, 'setRate'),
    ).toBe(true);
    expect(allowed(Role.SUPPORT, AdminVendorRatesController, 'rate')).toBe(
      false,
    );
  });
});
