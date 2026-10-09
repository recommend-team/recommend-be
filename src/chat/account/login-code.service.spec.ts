import { LoginCodeService, MAX_ATTEMPTS } from './login-code.service';

// No Redis: the in-memory store, which behaves the same.
describe('LoginCodeService', () => {
  let codes: LoginCodeService;

  beforeEach(() => {
    codes = new LoginCodeService();
  });

  const issue = async (email = 'ada@example.com', session = 's1') => {
    const result = await codes.issue(email, session);
    if (!result.ok) throw new Error(`not issued: ${result.reason}`);
    return result.code;
  };

  it('issues a six-digit code that works once', async () => {
    const code = await issue();

    expect(code).toMatch(/^\d{6}$/);
    expect(await codes.check('ada@example.com', code)).toEqual({ ok: true });
    expect(await codes.check('ada@example.com', code)).toEqual({
      ok: false,
      reason: 'EXPIRED',
    });
  });

  it('accepts the code typed with spaces', async () => {
    const code = await issue();

    await expect(
      codes.check('ada@example.com', `${code.slice(0, 3)} ${code.slice(3)}`),
    ).resolves.toEqual({ ok: true });
  });

  it('counts wrong codes down, then throws the code away', async () => {
    const code = await issue();
    const wrong = code === '000000' ? '111111' : '000000';

    for (let left = MAX_ATTEMPTS - 1; left > 0; left--) {
      expect(await codes.check('ada@example.com', wrong)).toEqual({
        ok: false,
        reason: 'WRONG',
        attemptsLeft: left,
      });
    }
    expect(await codes.check('ada@example.com', wrong)).toEqual({
      ok: false,
      reason: 'LOCKED',
    });
    // Even the right one is no use now.
    expect(await codes.check('ada@example.com', code)).toEqual({
      ok: false,
      reason: 'EXPIRED',
    });
  });

  it('makes a second request wait', async () => {
    await issue();

    const again = await codes.issue('ada@example.com', 's1');

    expect(again).toMatchObject({ ok: false, reason: 'COOLDOWN' });
  });

  it('caps how many codes one browser can ask for', async () => {
    for (let i = 0; i < 10; i++) await issue(`person${i}@example.com`, 's1');

    const eleventh = await codes.issue('another@example.com', 's1');

    expect(eleventh).toMatchObject({ ok: false, reason: 'TOO_MANY' });
  });

  it('gives no code for an address it was never sent to', async () => {
    await expect(codes.check('nobody@example.com', '123456')).resolves.toEqual({
      ok: false,
      reason: 'EXPIRED',
    });
  });
});
