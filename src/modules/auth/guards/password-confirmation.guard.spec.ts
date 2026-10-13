import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PasswordConfirmationGuard } from './password-confirmation.guard';

const contextFor = (
  user: unknown,
  body: Record<string, unknown> = {},
): ExecutionContext =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user, body }) }),
  }) as unknown as ExecutionContext;

describe('PasswordConfirmationGuard', () => {
  let guard: PasswordConfirmationGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let redis: { get: jest.Mock; setex: jest.Mock };
  let hashed: string;

  beforeAll(async () => {
    hashed = await argon2.hash('correct horse');
  });

  beforeEach(async () => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) };
    redis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordConfirmationGuard,
        { provide: Reflector, useValue: reflector },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(15) },
        },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();

    guard = module.get(PasswordConfirmationGuard);
  });

  it('lets undecorated routes through untouched', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);

    await expect(guard.canActivate(contextFor(undefined))).resolves.toBe(true);
  });

  it('accepts the correct password and opens a window', async () => {
    const context = contextFor(
      { id: 'u1', password: hashed },
      { currentPassword: 'correct horse' },
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(redis.setex).toHaveBeenCalledWith('pwconfirm:u1', 900, '1');
  });

  it('rejects the wrong password without opening one', async () => {
    const context = contextFor(
      { id: 'u1', password: hashed },
      { currentPassword: 'wrong' },
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it('demands a password when none was given and no window is open', async () => {
    const context = contextFor({ id: 'u1', password: hashed });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('honours a window opened moments ago', async () => {
    redis.get.mockResolvedValue('1');
    const context = contextFor({ id: 'u1', password: hashed });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('refuses a user who has no password at all', async () => {
    // Google-only accounts. Falling through would let a stolen session move money.
    const context = contextFor(
      { id: 'u1', password: null },
      { currentPassword: 'anything' },
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('asks every time when Redis is absent', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordConfirmationGuard,
        { provide: Reflector, useValue: reflector },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(15) },
        },
      ],
    }).compile();
    const bare = module.get(PasswordConfirmationGuard);

    // No cache means no window — the safe direction, since the alternative would be
    // treating "cannot check" as "already confirmed".
    await expect(
      bare.canActivate(contextFor({ id: 'u1', password: hashed })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      bare.canActivate(
        contextFor(
          { id: 'u1', password: hashed },
          { currentPassword: 'correct horse' },
        ),
      ),
    ).resolves.toBe(true);
  });
});
