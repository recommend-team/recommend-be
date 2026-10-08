import { PwaGateway } from './pwa.gateway';

/** Just enough of a Socket.IO socket to watch what the gateway does to it. */
const fakeSocket = (token?: string) => {
  const emitted: { event: string; data: unknown }[] = [];
  const rooms = new Set<string>();
  return {
    handshake: { auth: token ? { token } : {}, query: {} },
    data: {} as Record<string, unknown>,
    emitted,
    rooms,
    emit: jest.fn((event: string, data: unknown) => {
      emitted.push({ event, data });
      return true;
    }),
    join: jest.fn((room: string) => {
      rooms.add(room);
      return Promise.resolve();
    }),
    leave: jest.fn((room: string) => {
      rooms.delete(room);
      return Promise.resolve();
    }),
    disconnect: jest.fn(),
    events() {
      return emitted.map((entry) => entry.event);
    },
    last(event: string) {
      return [...emitted].reverse().find((entry) => entry.event === event)
        ?.data;
    },
  };
};

describe('PwaGateway — signing in', () => {
  const conversations = new Map<string, Record<string, unknown>>();
  let sessions: {
    inspect: jest.Mock;
    issue: jest.Mock;
    tokenFor: jest.Mock;
  };
  let conversationService: Record<string, jest.Mock>;
  let engine: { greet: jest.Mock; continueCheckoutAfterSignIn: jest.Mock };
  let accounts: Record<string, jest.Mock>;
  let gateway: PwaGateway;

  const conversation = (id: string, address: string, over = {}) => {
    const row = { id, channelAddress: address, mergedIntoId: null, ...over };
    conversations.set(id, row);
    return row;
  };

  beforeEach(() => {
    conversations.clear();
    sessions = {
      inspect: jest.fn((token?: string) =>
        Promise.resolve(token ? { sessionId: token, legacy: false } : null),
      ),
      issue: jest.fn(() =>
        Promise.resolve({ token: 'token-new', sessionId: 'session-new' }),
      ),
      tokenFor: jest.fn((sessionId: string) =>
        Promise.resolve(`token-for-${sessionId}`),
      ),
    };
    conversationService = {
      findOrCreate: jest.fn((_channel: string, address: string) => {
        const found = [...conversations.values()].find(
          (row) => row.channelAddress === address,
        );
        return Promise.resolve(
          found ?? conversation(`conv-${address}`, address),
        );
      }),
      findById: jest.fn((id: string) =>
        Promise.resolve(conversations.get(id) ?? null),
      ),
      resolveLive: jest.fn((row: { mergedIntoId: string | null }) =>
        Promise.resolve(
          row.mergedIntoId ? conversations.get(row.mergedIntoId) : row,
        ),
      ),
      countMessages: jest.fn(() => Promise.resolve(1)),
      getHistory: jest.fn(() =>
        Promise.resolve([
          {
            id: 'm1',
            author: 'ASSISTANT',
            text: 'Hi',
            payload: null,
            createdAt: new Date(),
          },
        ]),
      ),
    };
    engine = {
      greet: jest.fn(() => Promise.resolve({})),
      continueCheckoutAfterSignIn: jest.fn(() => Promise.resolve([])),
    };
    accounts = {
      emailFor: jest.fn(() => Promise.resolve(null)),
      requestCode: jest.fn(),
      verify: jest.fn(),
    };
    gateway = new PwaGateway(
      sessions as never,
      conversationService as never,
      engine as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      accounts as never,
    );
  });

  const connect = async (token?: string) => {
    const socket = fakeSocket(token);
    await gateway.handleConnection(socket as never);
    return socket;
  };

  it('moves a browser holding a folded conversation onto the live one as it connects', async () => {
    conversation('home', 'session-home');
    conversation('old', 'session-old', { mergedIntoId: 'home' });

    const socket = await connect('session-old');

    expect(socket.rooms).toEqual(new Set(['session-home']));
    expect(socket.data).toEqual({
      sessionId: 'session-home',
      conversationId: 'home',
    });
    expect(socket.last('session')).toEqual({
      token: 'token-for-session-home',
      sessionId: 'session-home',
    });
  });

  it('answers a code request, and passes on why one was refused', async () => {
    conversation('mine', 'session-mine');
    const socket = await connect('session-mine');

    accounts.requestCode.mockResolvedValueOnce({
      ok: true,
      email: 'ada@example.com',
      resendAfter: 30,
    });
    await gateway.onRequestCode(socket as never, { email: 'Ada@Example.com' });
    expect(accounts.requestCode).toHaveBeenCalledWith(
      'Ada@Example.com',
      'session-mine',
    );
    expect(socket.last('account:code-sent')).toEqual({
      email: 'ada@example.com',
      resendAfter: 30,
    });

    accounts.requestCode.mockResolvedValueOnce({
      ok: false,
      code: 'COOLDOWN',
      retryAfter: 22,
    });
    await gateway.onRequestCode(socket as never, { email: 'ada@example.com' });
    expect(socket.last('account:error')).toMatchObject({
      code: 'COOLDOWN',
      retryAfter: 22,
      message: expect.stringContaining('just sent a code') as unknown,
    });
  });

  it('on a right code, moves the browser to the account’s thread and sends it', async () => {
    conversation('mine', 'session-mine');
    const home = conversation('home', 'session-home');
    const socket = await connect('session-mine');
    socket.emitted.length = 0;
    accounts.verify.mockResolvedValue({
      ok: true,
      email: 'ada@example.com',
      conversation: home,
    });

    await gateway.onVerify(socket as never, {
      email: 'ada@example.com',
      code: '482916',
    });

    expect(accounts.verify).toHaveBeenCalledWith(
      'ada@example.com',
      '482916',
      'mine',
    );
    expect(socket.rooms).toEqual(new Set(['session-home']));
    expect(socket.data).toEqual({
      sessionId: 'session-home',
      conversationId: 'home',
    });
    // The token first, so a reconnect after this lands on the right thread.
    expect(socket.events()).toEqual(['session', 'account', 'chat:history']);
    expect(socket.last('account')).toEqual({ email: 'ada@example.com' });
    expect(conversationService.getHistory).toHaveBeenCalledWith('home', {});
    // Verified from the checkout's receipt card: the checkout carries on.
    expect(engine.continueCheckoutAfterSignIn).toHaveBeenCalledWith(home);
  });

  it('on a wrong code, says how many tries are left and moves nothing', async () => {
    conversation('mine', 'session-mine');
    const socket = await connect('session-mine');
    accounts.verify.mockResolvedValue({
      ok: false,
      code: 'WRONG_CODE',
      attemptsLeft: 3,
    });

    await gateway.onVerify(socket as never, {
      email: 'ada@example.com',
      code: '000000',
    });

    expect(socket.last('account:error')).toMatchObject({
      code: 'WRONG_CODE',
      attemptsLeft: 3,
    });
    expect(socket.rooms).toEqual(new Set(['session-mine']));
  });

  it('signing out starts this browser on a fresh, greeted chat', async () => {
    conversation('home', 'session-home', { accountId: 'account-1' });
    const socket = await connect('session-home');
    socket.emitted.length = 0;

    await gateway.onSignOut(socket as never);

    expect(socket.rooms).toEqual(new Set(['session-new']));
    expect(socket.data).toEqual({
      sessionId: 'session-new',
      conversationId: 'conv-session-new',
    });
    expect(socket.last('account')).toEqual({ email: null });
    expect(socket.last('session')).toEqual({
      token: 'token-for-session-new',
      sessionId: 'session-new',
    });
    expect(engine.greet).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv-session-new' }),
    );
  });

  it('tells a browser who it is signed in as', async () => {
    conversation('home', 'session-home', { accountId: 'account-1' });
    const socket = await connect('session-home');
    accounts.emailFor.mockResolvedValue('ada@example.com');

    await gateway.onAccountGet(socket as never);

    expect(socket.last('account')).toEqual({ email: 'ada@example.com' });
  });
});
