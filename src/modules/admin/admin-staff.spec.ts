import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import {
  ChangeAdminRoleSchema,
  CreateAdminSchema,
} from './dto/create-admin.dto';
import { Role } from '../../common/enums/roles.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';
import type { User } from '../auth/entities/auth.entity';

const person = (over: Partial<User> = {}) =>
  ({
    id: 's1',
    firstName: 'Amaka',
    lastName: 'Nwosu',
    email: 'amaka@recommend.app',
    role: Role.SUPPORT,
    status: SellerStatus.APPROVED,
    fullName: 'Amaka Nwosu',
    ...over,
  }) as User;

describe('AdminService — admins and customer service', () => {
  let users: {
    findOne: jest.Mock;
    findAndCount: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let service: AdminService;

  beforeEach(() => {
    users = {
      findOne: jest.fn().mockResolvedValue(null),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      create: jest.fn((value: Partial<User>) => value),
      save: jest.fn((value: Partial<User>) =>
        Promise.resolve({
          ...value,
          id: value.id ?? 'new',
          fullName: `${value.firstName} ${value.lastName}`,
        }),
      ),
    };
    // Only the users repository is touched by staff management.
    service = new AdminService(
      users as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  const create = (role?: string) =>
    CreateAdminSchema.parse({
      firstName: 'Amaka',
      lastName: 'Nwosu',
      email: 'amaka@recommend.app',
      password: 'SecurePass1',
      ...(role ? { role } : {}),
    });

  it('creates customer service when asked', async () => {
    const result = await service.createAdmin(create('SUPPORT'));

    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({
        role: Role.SUPPORT,
        status: SellerStatus.APPROVED,
      }),
    );
    expect(result.message).toBe(
      'Customer service account created for Amaka Nwosu',
    );
  });

  it('still makes a full admin when no role is given', async () => {
    await service.createAdmin(create());

    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({ role: Role.ADMIN }),
    );
  });

  it('never lets a super admin, vendor or buyer be created this way', () => {
    for (const role of ['SUPER_ADMIN', 'SELLER', 'BUYER']) {
      expect(() => create(role)).toThrow();
    }
    expect(() =>
      ChangeAdminRoleSchema.parse({ role: 'SUPER_ADMIN' }),
    ).toThrow();
  });

  it('lists admins and customer service together, or one of them', async () => {
    await service.getAdmins({});
    const [all] = users.findAndCount.mock.calls[0] as [
      { where: { role: { value: Role[] } } },
    ];
    expect(all.where.role.value).toEqual([Role.ADMIN, Role.SUPPORT]);

    await service.getAdmins({ role: Role.SUPPORT });
    const [some] = users.findAndCount.mock.calls[1] as [
      { where: { role: { value: Role[] } } },
    ];
    expect(some.where.role.value).toEqual([Role.SUPPORT]);
  });

  it('moves someone between admin and customer service', async () => {
    users.findOne.mockResolvedValue(person({ role: Role.ADMIN }));

    const result = await service.changeAdminRole('s1', Role.SUPPORT);

    expect(users.save).toHaveBeenCalledWith(
      expect.objectContaining({ role: Role.SUPPORT }),
    );
    expect(result.message).toBe('Amaka Nwosu is now customer service');
  });

  it('refuses a change to the role they already have', async () => {
    users.findOne.mockResolvedValue(person());

    await expect(service.changeAdminRole('s1', Role.SUPPORT)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('suspends and reactivates an agent', async () => {
    users.findOne.mockResolvedValue(person());
    await service.suspendAdmin('s1');
    expect(users.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: SellerStatus.SUSPENDED }),
    );

    users.findOne.mockResolvedValue(person({ status: SellerStatus.SUSPENDED }));
    const result = await service.activateAdmin('s1');
    expect(result.message).toBe(
      'Customer service Amaka Nwosu can sign in again',
    );
  });

  it('only manages admins and agents — never the super admin', async () => {
    // The lookup is limited to ADMIN and SUPPORT, so a super admin is simply not found.
    await expect(service.suspendAdmin('super')).rejects.toThrow(
      NotFoundException,
    );
    const [options] = users.findOne.mock.calls[0] as [
      { where: { role: { value: Role[] } } },
    ];
    expect(options.where.role.value).toEqual([Role.ADMIN, Role.SUPPORT]);
  });

  it('keeps an ordinary admin from suspending an agent through the user endpoints', async () => {
    users.findOne.mockResolvedValue(person());

    await expect(service.suspendUser('s1')).rejects.toThrow(
      'Use the super-admin endpoint to manage admin accounts',
    );
  });
});
