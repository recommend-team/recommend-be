import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AdminVendorsService } from './admin-vendors.service';
import { VendorAdminAction } from './entities/vendor-admin-edit.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { Role } from '../../common/enums/roles.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';
import { VendorType } from '../../common/enums/vendor-type.enum';
import type { User } from '../auth/entities/auth.entity';

const vendor = (over: Partial<User> = {}): User =>
  ({
    id: 'v1',
    email: 'ada@kitchen.ng',
    firstName: 'Ada',
    lastName: 'Obi',
    phoneNumber: '+2348011111111',
    role: Role.SELLER,
    status: SellerStatus.APPROVED,
    vendorType: VendorType.NON_REGISTERED,
    businessName: "Ada's Kitchen",
    password: 'hashed',
    ...over,
  }) as User;

describe('AdminVendorsService', () => {
  let users: Record<string, jest.Mock>;
  let pending: { findOne: jest.Mock };
  let products: { findOne: jest.Mock };
  let edits: { create: jest.Mock; save: jest.Mock };
  let auth: { sendSetPasswordLink: jest.Mock };
  let sellers: Record<string, jest.Mock>;
  let productsService: Record<string, jest.Mock>;
  let notifications: { create: jest.Mock };
  let push: { sendToUser: jest.Mock };
  let email: { sendEmail: jest.Mock };
  let service: AdminVendorsService;

  const logged = () =>
    edits.create.mock.calls.map(
      ([row]: [{ action: VendorAdminAction; summary: string }]) => row,
    );

  beforeEach(() => {
    users = {
      findOne: jest.fn().mockResolvedValue(vendor()),
      exists: jest.fn().mockResolvedValue(false),
      create: jest.fn((value: Partial<User>) => value),
      save: jest.fn((value: Partial<User>) =>
        Promise.resolve({ ...value, id: 'new' }),
      ),
      update: jest.fn().mockResolvedValue(undefined),
    };
    pending = { findOne: jest.fn().mockResolvedValue(null) };
    products = { findOne: jest.fn().mockResolvedValue({ name: 'Jollof' }) };
    edits = {
      create: jest.fn((row: unknown) => row),
      save: jest.fn().mockResolvedValue(undefined),
    };
    auth = { sendSetPasswordLink: jest.fn().mockResolvedValue(true) };
    sellers = {
      getProfile: jest.fn().mockResolvedValue({ data: { id: 'v1' } }),
      updateProfile: jest.fn().mockResolvedValue({ data: {} }),
      updateKyc: jest.fn().mockResolvedValue({ data: {} }),
    };
    productsService = {
      create: jest
        .fn()
        .mockResolvedValue({ data: { id: 'p1', name: 'Jollof' } }),
      update: jest
        .fn()
        .mockResolvedValue({ data: { id: 'p1', name: 'Jollof' } }),
      remove: jest.fn().mockResolvedValue({ message: 'deleted' }),
      findAllByVendor: jest.fn().mockResolvedValue({ data: { items: [] } }),
    };
    notifications = { create: jest.fn().mockResolvedValue({}) };
    push = { sendToUser: jest.fn().mockResolvedValue(1) };
    email = { sendEmail: jest.fn().mockResolvedValue(undefined) };

    service = new AdminVendorsService(
      users as never,
      pending as never,
      products as never,
      edits as never,
      auth as never,
      sellers as never,
      productsService as never,
      notifications as never,
      push as never,
      email as never,
    );
  });

  describe('setting up a vendor', () => {
    const dto = {
      firstName: 'Musa',
      lastName: 'Bello',
      email: 'musa@suya.ng',
      phoneNumber: '+2348022222222',
      vendorType: VendorType.NON_REGISTERED,
      businessName: 'Musa Suya Spot',
      businessAddress: '3 Allen Avenue, Ikeja',
      businessCategory: 'Food',
      areaIds: ['11111111-1111-4111-8111-111111111111'],
    };

    it('creates an approved, verified vendor with no password, a shop link and areas', async () => {
      users.findOne.mockResolvedValue(null);
      const result = await service.createVendor('admin1', dto);

      const [[created]] = users.create.mock.calls as [Partial<User>][];
      expect(created).toMatchObject({
        role: Role.SELLER,
        status: SellerStatus.APPROVED,
        isEmailVerified: true,
        password: null,
        slug: 'musa-suya-spot',
        orderQuota: 20,
      });
      expect(sellers.updateProfile).toHaveBeenCalledWith('new', {
        areaIds: dto.areaIds,
      });
      expect(auth.sendSetPasswordLink).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'new' }),
        'invite',
      );
      expect(result.data.inviteSent).toBe(true);
      expect(logged()[0]).toMatchObject({
        action: VendorAdminAction.CREATED,
        adminId: 'admin1',
      });
    });

    it('refuses an email or phone already in use — including a sign-up still verifying', async () => {
      users.findOne.mockResolvedValueOnce({ id: 'someone' });
      await expect(service.createVendor('admin1', dto)).rejects.toThrow(
        ConflictException,
      );

      pending.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'pending' });
      users.findOne.mockResolvedValue(null);
      await expect(service.createVendor('admin1', dto)).rejects.toThrow(
        /already belongs/,
      );
    });

    it('still creates the vendor when the invite email fails, and says so', async () => {
      auth.sendSetPasswordLink.mockResolvedValue(false);
      users.findOne.mockResolvedValue(null);

      const result = await service.createVendor('admin1', dto);

      expect(result.data.inviteSent).toBe(false);
      expect(result.message).toMatch(/did not send/);
    });
  });

  describe('changing a vendor', () => {
    it('sends store fields through the vendor’s own update, owner fields straight to the account', async () => {
      await service.updateVendor('admin1', 'v1', {
        businessName: 'Ada’s Place',
        isOpen: false,
        firstName: 'Adaeze',
        orderQuota: null,
      });

      expect(sellers.updateProfile).toHaveBeenCalledWith('v1', {
        businessName: 'Ada’s Place',
        isOpen: false,
      });
      expect(users.update).toHaveBeenCalledWith('v1', {
        firstName: 'Adaeze',
        orderQuota: null,
      });
      expect(logged().map((row) => row.action)).toEqual([
        VendorAdminAction.STORE_UPDATED,
        VendorAdminAction.OWNER_UPDATED,
      ]);
      expect(logged()[0].summary).toBe(
        'Changed business name and open / closed',
      );
    });

    it('tells the vendor once per save, in the feed and by push', async () => {
      await service.updateVendor('admin1', 'v1', {
        businessDescription: 'New description',
        whatsappNumber: '+2348033333333',
      });

      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'v1',
          type: NotificationType.STORE_UPDATED_BY_ADMIN,
          body: 'We changed your description and WhatsApp number.',
        }),
      );
      expect(push.sendToUser).toHaveBeenCalledTimes(1);
    });

    it('keeps phone numbers unique', async () => {
      users.findOne
        .mockResolvedValueOnce(vendor())
        .mockResolvedValueOnce({ id: 'other' });

      await expect(
        service.updateVendor('admin1', 'v1', { phoneNumber: '+2348099999999' }),
      ).rejects.toThrow(ConflictException);
      expect(users.update).not.toHaveBeenCalled();
    });

    it('is only for vendors', async () => {
      users.findOne.mockResolvedValue(null);
      await expect(
        service.updateVendor('admin1', 'x', { isOpen: true }),
      ).rejects.toThrow(NotFoundException);
    });

    it('a change saves even if its log line cannot be written', async () => {
      edits.save.mockRejectedValue(new Error('db blip'));
      await expect(
        service.updateVendor('admin1', 'v1', { isOpen: true }),
      ).resolves.toBeDefined();
      expect(sellers.updateProfile).toHaveBeenCalled();
    });
  });

  describe('login email', () => {
    it('changes it and tells the old address', async () => {
      users.findOne.mockResolvedValueOnce(vendor()).mockResolvedValueOnce(null);

      await service.changeEmail('admin1', 'v1', 'ada@new.ng');

      expect(users.update).toHaveBeenCalledWith(
        'v1',
        expect.objectContaining({ email: 'ada@new.ng' }),
      );
      expect(email.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'ada@kitchen.ng',
          template: 'login-email-changed',
        }),
      );
      expect(logged()[0].action).toBe(VendorAdminAction.EMAIL_CHANGED);
    });
  });

  describe('set-password link', () => {
    it('sends the invite to a vendor with no password, a reset to one with', async () => {
      users.findOne.mockResolvedValueOnce(vendor({ password: null }));
      await service.sendInvite('admin1', 'v1');
      expect(auth.sendSetPasswordLink).toHaveBeenLastCalledWith(
        expect.anything(),
        'invite',
      );

      users.findOne.mockResolvedValueOnce(vendor());
      await service.sendInvite('admin1', 'v1');
      expect(auth.sendSetPasswordLink).toHaveBeenLastCalledWith(
        expect.anything(),
        'reset',
      );
    });

    it('says so when the email does not send', async () => {
      auth.sendSetPasswordLink.mockResolvedValue(false);
      await expect(service.sendInvite('admin1', 'v1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('documents', () => {
    it('takes the documents that fit the vendor’s type', async () => {
      await service.updateKyc('admin1', 'v1', {
        ninDocumentUrl: 'https://res.cloudinary.com/x/nin.jpg',
      });
      expect(sellers.updateKyc).toHaveBeenCalledWith('v1', {
        ninDocumentUrl: 'https://res.cloudinary.com/x/nin.jpg',
      });
    });

    it('refuses documents for the other type', async () => {
      await expect(
        service.updateKyc('admin1', 'v1', {
          cacDocumentUrl: 'https://res.cloudinary.com/x/cac.pdf',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(sellers.updateKyc).not.toHaveBeenCalled();
    });
  });

  describe('products', () => {
    it('adds, changes and removes through the vendor’s own product rules — logged and told', async () => {
      await service.addProduct('admin1', 'v1', {
        name: 'Jollof',
        price: 3000,
        isAvailable: true,
        isAddOn: false,
      });
      await service.updateProduct('admin1', 'v1', 'p1', {
        price: 3200,
        isAvailable: false,
      });
      await service.removeProduct('admin1', 'v1', 'p1');

      expect(productsService.create).toHaveBeenCalledWith('v1', {
        name: 'Jollof',
        price: 3000,
        isAvailable: true,
        isAddOn: false,
      });
      expect(productsService.update).toHaveBeenCalledWith('v1', 'p1', {
        price: 3200,
        isAvailable: false,
      });
      expect(productsService.remove).toHaveBeenCalledWith('v1', 'p1');
      expect(logged().map((row) => row.summary)).toEqual([
        'Added Jollof',
        'Changed price and available on Jollof',
        'Removed Jollof',
      ]);
      expect(notifications.create).toHaveBeenCalledTimes(3);
    });
  });

  describe('removing a vendor', () => {
    it('deactivates and closes the store, keeping everything else', async () => {
      await service.deactivate('admin1', 'v1', 'Closed the business');

      expect(users.update).toHaveBeenCalledWith('v1', {
        status: SellerStatus.DEACTIVATED,
        isOpen: false,
      });
      expect(logged()[0]).toMatchObject({
        action: VendorAdminAction.DEACTIVATED,
        summary: 'Deactivated — Closed the business',
      });
    });

    it('does not deactivate twice', async () => {
      users.findOne.mockResolvedValue(
        vendor({ status: SellerStatus.DEACTIVATED }),
      );
      await expect(service.deactivate('admin1', 'v1')).rejects.toThrow(
        /already deactivated/,
      );
    });
  });
});
