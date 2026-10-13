import { MoreThanOrEqual } from 'typeorm';
import { AccountService } from './account.service';
import { ConversationState } from '../enums/chat.enums';
import { Conversation } from '../conversation/entities/conversation.entity';
import { ChatMessage } from '../conversation/entities/message.entity';
import { BuyerPushSubscription } from '../conversation/entities/buyer-push-subscription.entity';

const conversation = (over: Partial<Conversation>): Conversation =>
  ({
    id: 'c',
    channelAddress: 'session-c',
    state: ConversationState.DISCOVERY,
    context: {},
    accountId: null,
    mergedIntoId: null,
    buyerId: null,
    areaId: null,
    lastMessageAt: null,
    heldByAdminId: null,
    heldAt: null,
    lastAdminMessageAt: null,
    needsAttentionAt: null,
    attentionReason: null,
    handoverRequestedAt: null,
    handoverReason: null,
    ...over,
  }) as Conversation;

describe('AccountService', () => {
  let codes: { issue: jest.Mock; check: jest.Mock };
  let email: { sendSignInCode: jest.Mock; sendWelcome: jest.Mock };
  /** What the account insert returns: a row when it made the account, none when it existed. */
  let execute: jest.Mock;
  let manager: {
    createQueryBuilder: jest.Mock;
    findOneOrFail: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
  let service: AccountService;

  beforeEach(() => {
    codes = { issue: jest.fn(), check: jest.fn() };
    email = {
      sendSignInCode: jest.fn(),
      sendWelcome: jest.fn().mockResolvedValue(undefined),
    };
    execute = jest.fn().mockResolvedValue({ raw: [] });
    const insert = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute,
    };
    manager = {
      createQueryBuilder: jest.fn().mockReturnValue(insert),
      findOneOrFail: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    };
    const dataSource = {
      transaction: jest.fn((work: (m: typeof manager) => unknown) =>
        work(manager),
      ),
    };
    service = new AccountService(
      { findOne: jest.fn() } as never,
      codes as never,
      email as never,
      dataSource as never,
    );
  });

  describe('requestCode', () => {
    it('emails a code to the address as typed, tidied', async () => {
      codes.issue.mockResolvedValue({ ok: true, code: '482916' });

      const result = await service.requestCode('  Ada@Example.COM ', 's1');

      expect(result).toEqual({
        ok: true,
        email: 'ada@example.com',
        resendAfter: 30,
      });
      expect(email.sendSignInCode).toHaveBeenCalledWith(
        'ada@example.com',
        '482916',
        10,
      );
    });

    it('refuses something that is not an email, before sending anything', async () => {
      const result = await service.requestCode('not-an-email', 's1');

      expect(result).toEqual({ ok: false, code: 'INVALID_EMAIL' });
      expect(codes.issue).not.toHaveBeenCalled();
    });

    it('says so when the email could not be sent', async () => {
      codes.issue.mockResolvedValue({ ok: true, code: '482916' });
      email.sendSignInCode.mockRejectedValue(new Error('Brevo down'));

      await expect(
        service.requestCode('ada@example.com', 's1'),
      ).resolves.toEqual({ ok: false, code: 'SEND_FAILED' });
    });
  });

  describe('the welcome email', () => {
    const account = { id: 'account-1', email: 'ada@example.com' };

    beforeEach(() => {
      codes.check.mockResolvedValue({ ok: true });
      manager.findOneOrFail
        .mockResolvedValueOnce(account)
        .mockResolvedValueOnce(
          conversation({ id: 'mine', context: { profile: { name: 'Ada' } } }),
        );
      manager.findOne.mockResolvedValue(null);
    });

    it('is sent, by name, when this sign-in made the account', async () => {
      execute.mockResolvedValue({ raw: [{ id: 'account-1' }] });

      await service.verify('ada@example.com', '482916', 'mine');

      expect(email.sendWelcome).toHaveBeenCalledWith('ada@example.com', 'Ada');
    });

    it('is not sent again to an account that already existed', async () => {
      execute.mockResolvedValue({ raw: [] });

      await service.verify('ada@example.com', '482916', 'mine');

      expect(email.sendWelcome).not.toHaveBeenCalled();
    });
  });

  describe('verify', () => {
    const account = { id: 'account-1', email: 'ada@example.com' };

    it('turns a wrong code into how many tries are left', async () => {
      codes.check.mockResolvedValue({
        ok: false,
        reason: 'WRONG',
        attemptsLeft: 3,
      });

      await expect(
        service.verify('ada@example.com', '000000', 'c'),
      ).resolves.toEqual({
        ok: false,
        code: 'WRONG_CODE',
        attemptsLeft: 3,
      });
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('makes the first browser’s conversation the account’s own', async () => {
      codes.check.mockResolvedValue({ ok: true });
      const current = conversation({ id: 'mine' });
      manager.findOneOrFail
        .mockResolvedValueOnce(account)
        .mockResolvedValueOnce(current);
      manager.findOne.mockResolvedValue(null);

      const result = await service.verify('ada@example.com', '482916', 'mine');

      expect(result).toMatchObject({ ok: true, email: 'ada@example.com' });
      expect(result.ok && result.conversation.id).toBe('mine');
      expect(manager.update).toHaveBeenCalledWith(
        Conversation,
        { id: 'mine' },
        {
          accountId: 'account-1',
          context: { profile: { email: 'ada@example.com' } },
        },
      );
    });

    it('moves another browser onto the account’s conversation, bringing its chat', async () => {
      codes.check.mockResolvedValue({ ok: true });
      const home = conversation({
        id: 'home',
        channelAddress: 'session-home',
        accountId: 'account-1',
        context: { orderReferences: ['REC-OLD'] },
        lastMessageAt: new Date('2026-10-01T10:00:00Z'),
      });
      const current = conversation({
        id: 'other',
        context: { orderReferences: ['REC-NEW'] },
        lastMessageAt: new Date('2026-10-08T10:00:00Z'),
      });
      manager.findOneOrFail
        .mockResolvedValueOnce(account)
        .mockResolvedValueOnce(current);
      const firstWord = new Date('2026-10-08T09:59:00Z');
      manager.findOne
        .mockResolvedValueOnce(home)
        .mockResolvedValueOnce({ createdAt: firstWord });

      const result = await service.verify('ada@example.com', '482916', 'other');

      expect(result.ok && result.conversation.channelAddress).toBe(
        'session-home',
      );
      expect(result.ok && result.conversation.context.orderReferences).toEqual([
        'REC-OLD',
        'REC-NEW',
      ]);
      // From the buyer's first word on — the greeting before it stays behind.
      expect(manager.update).toHaveBeenCalledWith(
        ChatMessage,
        { conversationId: 'other', createdAt: MoreThanOrEqual(firstWord) },
        { conversationId: 'home' },
      );
      expect(manager.update).toHaveBeenCalledWith(
        BuyerPushSubscription,
        { conversationId: 'other' },
        { conversationId: 'home' },
      );
      expect(manager.update).toHaveBeenCalledWith(
        Conversation,
        { id: 'other' },
        expect.objectContaining({ mergedIntoId: 'home' }),
      );
    });

    it('leaves a greeting-only browser’s messages behind, so the greeting is not doubled', async () => {
      codes.check.mockResolvedValue({ ok: true });
      manager.findOneOrFail
        .mockResolvedValueOnce(account)
        .mockResolvedValueOnce(conversation({ id: 'fresh' }));
      manager.findOne
        .mockResolvedValueOnce(
          conversation({ id: 'home', accountId: 'account-1' }),
        )
        .mockResolvedValueOnce(null);

      await service.verify('ada@example.com', '482916', 'fresh');

      expect(manager.update).not.toHaveBeenCalledWith(
        ChatMessage,
        expect.anything(),
        expect.anything(),
      );
    });
  });
});
