import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { createRiderSchema } from './dto/rider.dto';
import { Role } from '../../common/enums/roles.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';
import { RiderType } from '../../common/enums/rider-type.enum';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { StatusActor } from '../orders/entities/order-status-event.entity';
import type { User } from '../auth/entities/auth.entity';

const rider = (over: Partial<User> = {}) =>
  ({
    id: 'r1',
    firstName: 'Musa',
    lastName: 'Bello',
    email: '2348011111111@riders.recommend.ng',
    phoneNumber: '+2348011111111',
    riderType: RiderType.INDIVIDUAL,
    riderNote: 'Has a bike',
    status: SellerStatus.APPROVED,
    createdAt: new Date('2026-10-01T09:00:00Z'),
    fullName: 'Musa Bello',
    ...over,
  }) as User;

describe('AdminService — riders', () => {
  let users: {
    findOne: jest.Mock;
    findAndCount: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let counts: { riderId: string; active: string; completed: string }[];
  let checkouts: { createQueryBuilder: jest.Mock; findOne: jest.Mock };
  let lifecycle: { assignRider: jest.Mock };
  let service: AdminService;

  beforeEach(() => {
    counts = [];
    users = {
      findOne: jest.fn().mockResolvedValue(null),
      findAndCount: jest.fn(),
      create: jest.fn((value: Partial<User>) => value),
      save: jest.fn((value: Partial<User>) =>
        Promise.resolve({
          ...value,
          id: 'new',
          createdAt: new Date(),
          fullName: `${value.firstName} ${value.lastName}`,
        }),
      ),
    };
    const qb: Record<string, jest.Mock> = {};
    for (const method of [
      'select',
      'addSelect',
      'where',
      'setParameters',
      'groupBy',
    ]) {
      qb[method] = jest.fn(() => qb);
    }
    qb.getRawMany = jest.fn(() => Promise.resolve(counts));
    checkouts = {
      createQueryBuilder: jest.fn(() => qb),
      findOne: jest.fn().mockResolvedValue({
        reference: 'REC-AAA',
        status: OrderStatus.READY,
        orders: [],
        createdAt: new Date(),
      }),
    };
    lifecycle = { assignRider: jest.fn().mockResolvedValue(undefined) };

    service = new AdminService(
      users as never,
      {} as never,
      {} as never,
      checkouts as never,
      {} as never,
      lifecycle as never,
      {} as never,
      {} as never,
    );
  });

  describe('adding a rider', () => {
    const dto = createRiderSchema.parse({
      firstName: 'Musa',
      lastName: 'Bello',
      phoneNumber: '0801 111 1111',
    });

    it('creates an approved rider with no password, and a placeholder email', async () => {
      const result = await service.createRider(dto);

      expect(users.create).toHaveBeenCalledWith(
        expect.objectContaining({
          role: Role.RIDER,
          status: SellerStatus.APPROVED,
          password: null,
          phoneNumber: '+2348011111111',
          email: '2348011111111@riders.recommend.ng',
          riderType: RiderType.INDIVIDUAL,
        }),
      );
      // The placeholder is never presented as an address.
      expect(result.data.email).toBeNull();
      expect(result.message).toBe('Musa Bello added as a rider');
    });

    it('keeps a real email, and the admin’s note', async () => {
      await service.createRider(
        createRiderSchema.parse({
          ...dto,
          phoneNumber: '+2348011111111',
          email: 'Musa@Example.com',
          note: 'Covers Lekki',
        }),
      );

      expect(users.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'musa@example.com',
          riderNote: 'Covers Lekki',
        }),
      );
    });

    it('refuses a phone that already belongs to an account', async () => {
      users.findOne.mockResolvedValue({ phoneNumber: '+2348011111111' });

      await expect(service.createRider(dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(users.save).not.toHaveBeenCalled();
    });
  });

  describe('the roster', () => {
    it('shows each rider’s deliveries in progress and completed', async () => {
      users.findAndCount.mockResolvedValue([
        [rider(), rider({ id: 'r2', email: 'tunde@example.com' })],
        2,
      ]);
      counts = [{ riderId: 'r1', active: '2', completed: '5' }];

      const page = await service.getRiders({});

      expect(page.items).toEqual([
        expect.objectContaining({
          id: 'r1',
          activeDeliveries: 2,
          completedDeliveries: 5,
          email: null,
        }),
        expect.objectContaining({
          id: 'r2',
          activeDeliveries: 0,
          completedDeliveries: 0,
          email: 'tunde@example.com',
        }),
      ]);
      expect(page.total).toBe(2);
    });

    it('searches name, phone and email, riders only', async () => {
      users.findAndCount.mockResolvedValue([[], 0]);

      await service.getRiders({ search: 'musa' });

      const [[options]] = users.findAndCount.mock.calls as [
        [{ where: Record<string, unknown>[] }],
      ];
      const where = options.where;
      expect(where).toHaveLength(4);
      for (const clause of where) expect(clause.role).toBe(Role.RIDER);
    });

    it('finds nobody when the id is not a rider', async () => {
      await expect(service.getRider('x')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('assigning a rider', () => {
    it('assigns an approved rider, as the admin', async () => {
      users.findOne.mockResolvedValue(rider());

      await service.assignRider('REC-AAA', 'r1', 'a1');

      expect(lifecycle.assignRider).toHaveBeenCalledWith(
        'REC-AAA',
        { id: 'r1', name: 'Musa Bello', phone: '+2348011111111' },
        { type: StatusActor.ADMIN, id: 'a1' },
      );
    });

    it.each([
      SellerStatus.SUSPENDED,
      SellerStatus.PENDING,
      SellerStatus.DEACTIVATED,
    ])('refuses a rider who is %s', async (status) => {
      users.findOne.mockResolvedValue(rider({ status }));

      await expect(
        service.assignRider('REC-AAA', 'r1', 'a1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(lifecycle.assignRider).not.toHaveBeenCalled();
    });

    it('refuses someone who is not a rider', async () => {
      await expect(
        service.assignRider('REC-AAA', 'v1', 'a1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('createRiderSchema', () => {
  it('normalises the phone, so one rider cannot be added twice in two formats', () => {
    expect(
      createRiderSchema.parse({
        firstName: 'Musa',
        lastName: 'Bello',
        phoneNumber: '0801 111 1111',
      }).phoneNumber,
    ).toBe('+2348011111111');
  });

  it('treats an empty email as none', () => {
    expect(
      createRiderSchema.parse({
        firstName: 'Musa',
        lastName: 'Bello',
        phoneNumber: '08011111111',
        email: '',
      }).email,
    ).toBeUndefined();
  });

  it.each([
    ['a phone that is not one', { phoneNumber: 'call me' }],
    ['a bad email', { email: 'not-an-email' }],
    ['a one-letter name', { firstName: 'M' }],
  ])('rejects %s', (_label, over) => {
    expect(
      createRiderSchema.safeParse({
        firstName: 'Musa',
        lastName: 'Bello',
        phoneNumber: '08011111111',
        ...over,
      }).success,
    ).toBe(false);
  });
});
