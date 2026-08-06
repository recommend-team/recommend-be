import { Test, TestingModule } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { SessionService } from './session.service';

describe('SessionService', () => {
  let service: SessionService;
  let jwtService: JwtService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({})],
      providers: [
        SessionService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test-chat-secret') },
        },
      ],
    }).compile();

    service = module.get<SessionService>(SessionService);
    jwtService = module.get<JwtService>(JwtService);
  });

  it('issues a token that verifies back to the same session id', async () => {
    const { token, sessionId } = await service.issue();

    await expect(service.verify(token)).resolves.toBe(sessionId);
  });

  it('issues a distinct session every time', async () => {
    const first = await service.issue();
    const second = await service.issue();

    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it('re-issues a token for an existing session without changing its id', async () => {
    const { sessionId } = await service.issue();

    const reissued = await service.tokenFor(sessionId);

    await expect(service.verify(reissued)).resolves.toBe(sessionId);
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = await jwtService.signAsync(
      { sid: 'attacker-chosen' },
      { secret: 'not-our-secret' },
    );

    await expect(service.verify(forged)).resolves.toBeNull();
  });

  it('rejects an expired token', async () => {
    const expired = await jwtService.signAsync(
      { sid: 'stale' },
      { secret: 'test-chat-secret', expiresIn: '-1s' },
    );

    await expect(service.verify(expired)).resolves.toBeNull();
  });

  it('rejects a missing token rather than throwing', async () => {
    await expect(service.verify(undefined)).resolves.toBeNull();
    await expect(service.verify('')).resolves.toBeNull();
  });

  it('rejects arbitrary junk', async () => {
    await expect(service.verify('not-a-jwt')).resolves.toBeNull();
  });

  it('carries no subject, so it cannot pass as a platform auth token', async () => {
    const { token } = await service.issue();
    const decoded: Record<string, unknown> = jwtService.decode(token);

    expect(decoded.sub).toBeUndefined();
    expect(decoded.role).toBeUndefined();
    expect(Object.keys(decoded)).toEqual(
      expect.arrayContaining(['sid', 'iat', 'exp']),
    );
  });
});
