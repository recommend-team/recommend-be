import { AuthService } from './auth.service';
import { Role } from '../../common/enums/roles.enum';
import { uniqueSlug } from '../../common/utils/slug.util';

/**
 * A vendor's business, as given at sign-up, survives verification — before this it was
 * dropped, and a new vendor started with no name, category or store link.
 */
describe('AuthService — a vendor’s business at sign-up', () => {
  const setup = (takenSlugs: string[] = []) => {
    const users = {
      create: jest.fn((input: Record<string, unknown>) => input),
      save: jest.fn((input: Record<string, unknown>) =>
        Promise.resolve({ id: 'u1', ...input }),
      ),
      exists: jest.fn(({ where }: { where: { slug: string } }) =>
        Promise.resolve(takenSlugs.includes(where.slug)),
      ),
      findOne: jest.fn().mockResolvedValue(null),
    };
    const pending = {
      create: jest.fn((input: Record<string, unknown>) => input),
      save: jest.fn((input: Record<string, unknown>) => Promise.resolve(input)),
      findOne: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AuthService(
      users as never,
      {} as never,
      pending as never,
      {} as never,
      {} as never,
      { sendEmail: jest.fn().mockResolvedValue(undefined) } as never,
      { send: jest.fn().mockResolvedValue(undefined) } as never,
    );
    return { service, users, pending };
  };

  it('keeps the business details on the pending sign-up', async () => {
    const { service, pending } = setup();

    await service.registerVendor({
      email: 'ngozi@example.com',
      password: 'Welcome@2026',
      firstName: 'Ngozi',
      lastName: 'Okafor',
      phoneNumber: '+2348011112222',
      vendorType: 'REGISTERED',
      businessName: ' Mama Ngozi Kitchen ',
      businessAddress: '12 Admiralty Way, Lekki',
      businessCategory: 'Restaurant',
      businessDescription: '',
    } as never);

    expect(pending.create).toHaveBeenCalledWith(
      expect.objectContaining({
        businessName: 'Mama Ngozi Kitchen',
        businessAddress: '12 Admiralty Way, Lekki',
        businessCategory: 'Restaurant',
        businessDescription: null,
      }),
    );
  });

  it('carries them onto the account with a store link, at verification', async () => {
    const { service, users, pending } = setup(['mama-ngozi-kitchen']);
    pending.findOne.mockResolvedValue({
      email: 'ngozi@example.com',
      verificationCode: '123456',
      verificationCodeExpiresAt: new Date(Date.now() + 60_000),
      password: 'hash',
      firstName: 'Ngozi',
      lastName: 'Okafor',
      phoneNumber: '+2348011112222',
      role: Role.SELLER,
      vendorType: 'REGISTERED',
      riderType: null,
      businessName: 'Mama Ngozi Kitchen',
      businessAddress: '12 Admiralty Way, Lekki',
      businessCategory: 'Restaurant',
      businessDescription: null,
    });

    await service.verifyEmail({ email: 'ngozi@example.com', code: '123456' });

    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({
        businessName: 'Mama Ngozi Kitchen',
        businessCategory: 'Restaurant',
        businessAddress: '12 Admiralty Way, Lekki',
        // The plain link was taken, so the next free one.
        slug: 'mama-ngozi-kitchen-2',
      }),
    );
  });

  it('gives a rider no store link', async () => {
    const { service, users, pending } = setup();
    pending.findOne.mockResolvedValue({
      email: 'musa@example.com',
      verificationCode: '123456',
      verificationCodeExpiresAt: new Date(Date.now() + 60_000),
      password: 'hash',
      firstName: 'Musa',
      lastName: 'Bello',
      phoneNumber: '+2348033334444',
      role: Role.RIDER,
      vendorType: null,
      riderType: 'INDIVIDUAL',
      businessName: null,
      businessAddress: null,
      businessCategory: null,
      businessDescription: null,
    });

    await service.verifyEmail({ email: 'musa@example.com', code: '123456' });

    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: null }),
    );
  });
});

describe('uniqueSlug', () => {
  it('makes a link from the name, and numbers it when taken', async () => {
    const taken = new Set(['mama-ngozi-kitchen', 'mama-ngozi-kitchen-2']);

    await expect(
      uniqueSlug('Mama Ngozi Kitchen!', (slug) =>
        Promise.resolve(taken.has(slug)),
      ),
    ).resolves.toBe('mama-ngozi-kitchen-3');
  });

  it('never returns an empty link', async () => {
    await expect(uniqueSlug('!!!', () => Promise.resolve(false))).resolves.toBe(
      'store',
    );
  });
});
