import { BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Role } from '../../common/enums/roles.enum';
import { clientIp } from '../../common/guards/client-ip-throttler.guard';
import { maskEmail, maskIp } from '../../common/utils/redact.util';

/**
 * Sign-up can't be brute-forced or read back: the password is hashed before it is
 * stored anywhere, the email code comes from a secure generator, and five wrong guesses
 * cancel the sign-up.
 */
describe('AuthService — signing up safely', () => {
  const setup = () => {
    const users = {
      create: jest.fn((input: Record<string, unknown>) => input),
      save: jest.fn((input: Record<string, unknown>) =>
        Promise.resolve({ id: 'u1', ...input }),
      ),
      exists: jest.fn().mockResolvedValue(false),
      findOne: jest.fn().mockResolvedValue(null),
    };
    const pending = {
      create: jest.fn((input: Record<string, unknown>) => input),
      save: jest.fn((input: Record<string, unknown>) => Promise.resolve(input)),
      findOne: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const sendEmail = jest.fn().mockResolvedValue(undefined);
    const service = new AuthService(
      users as never,
      {} as never,
      pending as never,
      {} as never,
      {} as never,
      { sendEmail } as never,
      { send: jest.fn().mockResolvedValue(undefined) } as never,
    );
    return { service, users, pending, sendEmail };
  };

  const pendingRider = (over: Record<string, unknown> = {}) => ({
    email: 'tunde@example.com',
    verificationCode: '483920',
    verificationCodeExpiresAt: new Date(Date.now() + 60_000),
    verificationAttempts: 0,
    password: '$argon2id$v=19$m=65536,t=3,p=4$abc$def',
    firstName: 'Tunde',
    lastName: 'Bakare',
    phoneNumber: '+2348011113333',
    role: Role.RIDER,
    vendorType: null,
    riderType: 'SOLO',
    ...over,
  });

  it('never stores the password as typed', async () => {
    const { service, pending } = setup();

    await service.registerRider({
      email: 'tunde@example.com',
      password: 'Welcome@2026',
      firstName: 'Tunde',
      lastName: 'Bakare',
      phoneNumber: '+2348011113333',
      riderType: 'SOLO',
    } as never);

    const stored = (pending.create.mock.calls[0] as [{ password: string }])[0]
      .password;
    expect(stored).not.toBe('Welcome@2026');
    expect(stored.startsWith('$argon2')).toBe(true);
  });

  it('sends a six-digit code', async () => {
    const { service, pending } = setup();

    await service.registerRider({
      email: 'tunde@example.com',
      password: 'Welcome@2026',
      firstName: 'Tunde',
      lastName: 'Bakare',
      phoneNumber: '+2348011113333',
      riderType: 'SOLO',
    } as never);

    const { verificationCode } = (
      pending.create.mock.calls[0] as [{ verificationCode: string }]
    )[0];
    expect(verificationCode).toMatch(/^[1-9]\d{5}$/);
  });

  it('counts a wrong code, and says only that it is wrong', async () => {
    const { service, pending } = setup();
    const row = pendingRider();
    pending.findOne.mockResolvedValue(row);

    await expect(
      service.verifyEmail({ email: row.email, code: '000000' }),
    ).rejects.toThrow('Invalid email or verification code');
    expect(pending.save).toHaveBeenCalledWith(
      expect.objectContaining({ verificationAttempts: 1 }),
    );
    expect(pending.remove).not.toHaveBeenCalled();
  });

  it('cancels the sign-up at the fifth wrong code', async () => {
    const { service, pending } = setup();
    const row = pendingRider({ verificationAttempts: 4 });
    pending.findOne.mockResolvedValue(row);

    await expect(
      service.verifyEmail({ email: row.email, code: '000000' }),
    ).rejects.toThrow('Too many wrong codes');
    expect(pending.remove).toHaveBeenCalledWith(row);
  });

  it('verifies with the right code, and keeps the hash it was given', async () => {
    const { service, pending, users } = setup();
    const row = pendingRider();
    pending.findOne.mockResolvedValue(row);

    await service.verifyEmail({ email: row.email, code: '483920' });

    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({ password: row.password }),
    );
    expect(pending.remove).toHaveBeenCalledWith(row);
  });

  it('starts the count again when a new code is sent', async () => {
    const { service, pending } = setup();
    const row = pendingRider({ verificationAttempts: 3 });
    pending.findOne.mockResolvedValue(row);

    await service.resendVerificationEmail(row.email);

    expect(pending.save).toHaveBeenCalledWith(
      expect.objectContaining({ verificationAttempts: 0 }),
    );
    expect(row.verificationCode).not.toBe('483920');
  });

  it('does not tell an unknown email from a wrong code', async () => {
    const { service, pending } = setup();
    pending.findOne.mockResolvedValue(null);

    await expect(
      service.verifyEmail({ email: 'nobody@example.com', code: '123456' }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('the client address rate limits count by', () => {
  it('is the one Heroku added — the last — not one the caller sent', () => {
    expect(
      clientIp({
        headers: { 'x-forwarded-for': '1.2.3.4, 102.89.34.17' },
        ip: '10.0.0.1',
      }),
    ).toBe('102.89.34.17');
  });

  it('falls back to the socket when there is no proxy', () => {
    expect(clientIp({ headers: {}, ip: '127.0.0.1' })).toBe('127.0.0.1');
  });
});

describe('what goes into the logs', () => {
  it.each([
    ['ada.obi@gmail.com', 'ad***@gmail.com'],
    ['a@x.com', 'a***@x.com'],
    [null, '(no email)'],
  ])('masks the email %p', (email, masked) => {
    expect(maskEmail(email)).toBe(masked);
  });

  it('keeps only the network part of an address', () => {
    expect(maskIp('102.89.34.17')).toBe('102.89.34.x');
    expect(maskIp('2001:db8:85a3:0:0:8a2e:370:7334')).toBe('2001:db8:85a3:0:…');
  });
});
