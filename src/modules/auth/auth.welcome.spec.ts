import { AuthService } from './auth.service';
import { Role } from '../../common/enums/roles.enum';

/** The welcome email at sign-up verification. The rest of AuthService is out of scope. */
describe('AuthService — welcome on first verification', () => {
  const pending = (role: Role) => ({
    email: 'ada@example.com',
    verificationCode: '123456',
    verificationCodeExpiresAt: new Date(Date.now() + 60_000),
    password: 'hash',
    firstName: 'Ada',
    lastName: 'Obi',
    phoneNumber: '+2348012345678',
    role,
    vendorType: null,
    riderType: null,
  });

  const setup = (role: Role) => {
    const users = {
      create: jest.fn((input: Record<string, unknown>) => input),
      save: jest.fn((input: Record<string, unknown>) =>
        Promise.resolve({ id: 'u1', ...input }),
      ),
    };
    const pendingUsers = {
      findOne: jest.fn().mockResolvedValue(pending(role)),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const welcome = { send: jest.fn().mockResolvedValue(undefined) };
    const service = new AuthService(
      users as never,
      {} as never,
      pendingUsers as never,
      {} as never,
      {} as never,
      {} as never,
      welcome as never,
    );
    return { service, welcome };
  };

  it.each([
    [Role.SELLER, 'vendor'],
    [Role.RIDER, 'rider'],
    [Role.BUYER, 'customer'],
  ] as const)('welcomes a new %s as a %s', async (role, audience) => {
    const { service, welcome } = setup(role);

    await service.verifyEmail({ email: 'ada@example.com', code: '123456' });

    expect(welcome.send).toHaveBeenCalledWith(
      audience,
      'ada@example.com',
      'Ada',
    );
  });

  it('still verifies when the welcome cannot be sent', async () => {
    const { service, welcome } = setup(Role.SELLER);
    // The service itself never throws; even a broken one must not reach the caller.
    welcome.send.mockReturnValue(new Promise(() => undefined));

    await expect(
      service.verifyEmail({ email: 'ada@example.com', code: '123456' }),
    ).resolves.toMatchObject({ data: { user: expect.anything() as unknown } });
  });

  it('sends nothing for a wrong code', async () => {
    const { service, welcome } = setup(Role.SELLER);
    (
      service as unknown as { pendingUsersRepository: { findOne: jest.Mock } }
    ).pendingUsersRepository.findOne.mockResolvedValue(null);

    await expect(
      service.verifyEmail({ email: 'ada@example.com', code: '000000' }),
    ).rejects.toThrow('Invalid email or verification code');
    expect(welcome.send).not.toHaveBeenCalled();
  });
});
