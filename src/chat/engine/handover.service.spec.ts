import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { HandoverService } from './handover.service';
import { Conversation } from '../conversation/entities/conversation.entity';
import { ConversationService } from '../conversation/conversation.service';
import { ChannelRegistry } from '../transport/channel.registry';
import { ChatChannel, ConversationState } from '../enums/chat.enums';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CONVERSATION_HANDED_OVER_EVENT,
  ConversationHandedOverEvent,
  HELD_CONVERSATION_MESSAGE_EVENT,
  HeldConversationMessageEvent,
} from '../../common/events/admin-alert.events';

const STALE_MINUTES = 30;
const WAIT_MINUTES = 5;
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe('HandoverService', () => {
  let service: HandoverService;
  let row: Conversation;
  let updates: Record<string, unknown>[];
  let sent: { address: string; text: string }[];
  let emitTyping: jest.Mock;
  let recordOutbound: jest.Mock;
  let flagForAttention: jest.Mock;
  let mergeContext: jest.Mock;
  const events = { emit: jest.fn() };

  const conversation = (over: Partial<Conversation> = {}): Conversation =>
    ({
      id: 'c1',
      channel: ChatChannel.PWA,
      channelAddress: 'session-1',
      state: ConversationState.DISCOVERY,
      heldByAdminId: null,
      heldAt: null,
      lastAdminMessageAt: null,
      ...over,
    }) as Conversation;

  beforeEach(async () => {
    row = conversation();
    updates = [];
    sent = [];
    emitTyping = jest.fn();

    const conversations = {
      findOne: jest.fn(() => Promise.resolve(row)),
      update: jest.fn((_where: unknown, patch: Record<string, unknown>) => {
        updates.push(patch);
        Object.assign(row, patch);
        return Promise.resolve({ affected: 1 });
      }),
    };

    recordOutbound = jest.fn(() =>
      Promise.resolve({ id: 'm1', createdAt: new Date() }),
    );
    flagForAttention = jest.fn();
    mergeContext = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HandoverService,
        { provide: getRepositoryToken(Conversation), useValue: conversations },
        {
          provide: ConversationService,
          useValue: {
            recordOutbound,
            clearAttention: jest.fn(),
            flagForAttention,
            mergeContext,
          },
        },
        {
          provide: ChannelRegistry,
          useValue: {
            send: jest.fn(
              (
                _channel: unknown,
                address: string,
                message: { text: string },
              ) => {
                sent.push({ address, text: message.text });
                return Promise.resolve(null);
              },
            ),
            get: jest.fn(() => ({ emitTyping })),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'chat.handoverWaitMinutes' ? WAIT_MINUTES : STALE_MINUTES,
            ),
          },
        },
        {
          provide: EventEmitter2,
          useValue: events,
        },
      ],
    }).compile();

    service = module.get(HandoverService);
  });

  describe('taking a conversation', () => {
    it('records who holds it', async () => {
      await service.take('c1', 'admin-1');

      expect(row.heldByAdminId).toBe('admin-1');
      expect(row.heldAt).toBeInstanceOf(Date);
    });

    it('refuses one another admin is already answering', async () => {
      row = conversation({ heldByAdminId: 'admin-2', heldAt: new Date() });

      await expect(service.take('c1', 'admin-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('lets the same admin re-take their own, so a refresh is harmless', async () => {
      const held = minutesAgo(5);
      row = conversation({ heldByAdminId: 'admin-1', heldAt: held });

      await service.take('c1', 'admin-1');

      // The original claim time survives — a refresh must not look like a new takeover.
      expect(row.heldAt).toBe(held);
    });

    it('404s on a conversation that does not exist', async () => {
      const empty = { findOne: jest.fn(() => Promise.resolve(null)) };
      const module = await Test.createTestingModule({
        providers: [
          HandoverService,
          { provide: getRepositoryToken(Conversation), useValue: empty },
          {
            provide: ConversationService,
            useValue: { clearAttention: jest.fn() },
          },
          { provide: ChannelRegistry, useValue: {} },
          { provide: ConfigService, useValue: { get: () => STALE_MINUTES } },
          { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        ],
      }).compile();

      await expect(
        module.get(HandoverService).take('nope', 'admin-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('while it is held', () => {
    beforeEach(() => {
      row = conversation({
        heldByAdminId: 'admin-1',
        heldAt: minutesAgo(2),
        lastAdminMessageAt: minutesAgo(2),
      });
    });

    it('keeps the assistant quiet', async () => {
      await expect(service.shouldStaySilent(row)).resolves.toBe(true);
    });

    it('reaches the buyer on the same channel the assistant uses', async () => {
      await service.send('c1', 'admin-1', 'Sorry about that — sorted now.');

      expect(sent).toEqual([
        { address: 'session-1', text: 'Sorry about that — sorted now.' },
      ]);
    });

    it('attributes the message without changing who the buyer sees', async () => {
      await service.send('c1', 'admin-1', 'Hello');

      // No author override: it stays ASSISTANT, and only adminId records the truth.
      expect(recordOutbound).toHaveBeenCalledWith({
        conversationId: 'c1',
        text: 'Hello',
        adminId: 'admin-1',
      });
    });

    it('refuses a reply from an admin who has not taken it', async () => {
      await expect(
        service.send('c1', 'someone-else', 'Hello'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(sent).toHaveLength(0);
    });

    it('passes typing through to the buyer', async () => {
      await service.setTyping('c1', 'admin-1', true);

      expect(emitTyping).toHaveBeenCalledWith('session-1', true);
    });

    it('ignores typing from an admin who does not hold it', async () => {
      await service.setTyping('c1', 'other', true);

      expect(emitTyping).not.toHaveBeenCalled();
    });
  });

  describe('handing back', () => {
    it('clears the hold', async () => {
      row = conversation({ heldByAdminId: 'admin-1', heldAt: new Date() });

      await service.release('c1', 'admin-1');

      expect(row.heldByAdminId).toBeNull();
    });

    it('sends nothing', async () => {
      row = conversation({ heldByAdminId: 'admin-1', heldAt: new Date() });

      await service.release('c1', 'admin-1');

      // The assistant answers the next thing the buyer says. A conversation that ended
      // stays ended rather than being restarted by a bot with nothing to add.
      expect(sent).toHaveLength(0);
      expect(recordOutbound).not.toHaveBeenCalled();
    });

    it('resets a checkout in progress back to browsing', async () => {
      // Handing back into COLLECTING_PHONE means the buyer's next sentence is parsed as
      // a phone number and rejected — the bot failing seconds after a person fixed it.
      row = conversation({
        heldByAdminId: 'admin-1',
        heldAt: new Date(),
        state: ConversationState.COLLECTING_PHONE,
      });

      await service.release('c1', 'admin-1');

      expect(row.state).toBe(ConversationState.DISCOVERY);
    });

    it('leaves an already-browsing conversation alone', async () => {
      row = conversation({ heldByAdminId: 'admin-1', heldAt: new Date() });

      await service.release('c1', 'admin-1');

      expect(updates.some((patch) => 'state' in patch)).toBe(false);
    });

    it('refuses to release someone else’s', async () => {
      row = conversation({ heldByAdminId: 'admin-2', heldAt: new Date() });

      await expect(service.release('c1', 'admin-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('is harmless on one nobody holds', async () => {
      await expect(service.release('c1', 'admin-1')).resolves.toBeDefined();
    });
  });

  describe('an admin who never came back', () => {
    it('holds while they are recently active', async () => {
      row = conversation({
        heldByAdminId: 'admin-1',
        heldAt: minutesAgo(90),
        lastAdminMessageAt: minutesAgo(STALE_MINUTES - 1),
      });

      // Measured from their last message, not from when they took it — an admin an hour
      // into a conversation has not abandoned it.
      await expect(service.shouldStaySilent(row)).resolves.toBe(true);
    });

    it('releases when a buyer speaks and the admin has gone', async () => {
      row = conversation({
        heldByAdminId: 'admin-1',
        heldAt: minutesAgo(120),
        lastAdminMessageAt: minutesAgo(STALE_MINUTES + 1),
      });

      // False means the engine answers *this* message — not one is ignored.
      await expect(service.shouldStaySilent(row)).resolves.toBe(false);
      expect(row.heldByAdminId).toBeNull();
    });

    it('resets a stranded checkout on the way out', async () => {
      row = conversation({
        heldByAdminId: 'admin-1',
        heldAt: minutesAgo(120),
        lastAdminMessageAt: minutesAgo(STALE_MINUTES + 1),
        state: ConversationState.CONFIRMING_ORDER,
      });

      await service.shouldStaySilent(row);

      expect(row.state).toBe(ConversationState.DISCOVERY);
    });

    it('never silences a conversation nobody holds', async () => {
      await expect(service.shouldStaySilent(row)).resolves.toBe(false);
    });
  });

  describe('a buyer writing while an admin holds it', () => {
    beforeEach(() => events.emit.mockClear());

    it('tells the admin holding it, and only them', () => {
      service.announceBuyerWaiting(
        conversation({
          heldByAdminId: 'admin-1',
          context: { profile: { name: 'Ada' } },
        } as Partial<Conversation>),
        'Is it coming?',
      );

      expect(events.emit).toHaveBeenCalledWith(
        HELD_CONVERSATION_MESSAGE_EVENT,
        new HeldConversationMessageEvent(
          'c1',
          'admin-1',
          'Is it coming?',
          'Ada',
        ),
      );
    });

    it('says nothing for a conversation nobody holds', () => {
      service.announceBuyerWaiting(conversation(), 'hello');

      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('the assistant asking for a teammate', () => {
    beforeEach(() => events.emit.mockClear());

    it('marks it waiting, flags it quietly, and alerts with the wait', async () => {
      row = conversation({ context: { profile: { name: 'Ada' } } });

      await expect(
        service.requestHandover(row, 'Wants a refund'),
      ).resolves.toBe(true);

      expect(row.handoverRequestedAt).toBeInstanceOf(Date);
      expect(row.handoverReason).toBe('Wants a refund');
      // Quietly — the handover's own alert is the louder one.
      expect(flagForAttention).toHaveBeenCalledWith(
        'c1',
        'Wants a refund',
        'Ada',
        {
          silent: true,
        },
      );
      expect(events.emit).toHaveBeenCalledWith(
        CONVERSATION_HANDED_OVER_EVENT,
        new ConversationHandedOverEvent(
          'c1',
          'Wants a refund',
          'Ada',
          WAIT_MINUTES,
        ),
      );
    });

    it('will not hand over a conversation someone already holds', async () => {
      row = conversation({ heldByAdminId: 'admin-1' });

      await expect(service.requestHandover(row, 'x')).resolves.toBe(false);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('will not hand over twice while one is waiting', async () => {
      row = conversation({ handoverRequestedAt: minutesAgo(1) });

      await expect(service.requestHandover(row, 'x')).resolves.toBe(false);
    });

    it('will not park the buyer again after a handover went unanswered', async () => {
      row = conversation({
        context: { unansweredHandoverAt: new Date().toISOString() },
      });

      await expect(service.requestHandover(row, 'x')).resolves.toBe(false);
      expect(updates).toHaveLength(0);
    });

    it('loses a race cleanly', async () => {
      // Two turns at once: the conditional update lets only one of them through.
      row = conversation();
      const repository = (
        service as unknown as { conversations: { update: jest.Mock } }
      ).conversations;
      repository.update.mockResolvedValueOnce({ affected: 0 });

      await expect(service.requestHandover(row, 'x')).resolves.toBe(false);
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('waiting for a teammate', () => {
    it('is nothing to wait for without a handover', async () => {
      await expect(service.awaitingTeammate(conversation())).resolves.toBe(
        'none',
      );
    });

    it('waits inside the window', async () => {
      row = conversation({ handoverRequestedAt: minutesAgo(WAIT_MINUTES - 1) });

      await expect(service.awaitingTeammate(row)).resolves.toBe('waiting');
      expect(updates).toHaveLength(0);
    });

    it('gives up after it, clears the handover, and remembers nobody came', async () => {
      row = conversation({
        handoverRequestedAt: minutesAgo(WAIT_MINUTES + 1),
        handoverReason: 'Wants a refund',
      });

      await expect(service.awaitingTeammate(row)).resolves.toBe('expired');

      expect(row.handoverRequestedAt).toBeNull();
      expect(row.handoverReason).toBeNull();
      const [, patch] = mergeContext.mock.calls[0] as [
        string,
        { unansweredHandoverAt?: string },
      ];
      expect(typeof patch.unansweredHandoverAt).toBe('string');
    });

    it('is nothing to wait for once an admin holds it', async () => {
      row = conversation({
        heldByAdminId: 'admin-1',
        handoverRequestedAt: minutesAgo(WAIT_MINUTES + 1),
      });

      await expect(service.awaitingTeammate(row)).resolves.toBe('none');
    });

    it('is answered by an admin taking it', async () => {
      row = conversation({
        handoverRequestedAt: minutesAgo(1),
        handoverReason: 'Wants a refund',
        context: { unansweredHandoverAt: 'earlier', strugglingTurns: 2 },
      });

      await service.take('c1', 'admin-1');

      expect(row.handoverRequestedAt).toBeNull();
      expect(row.handoverReason).toBeNull();
      // A clean slate: once a person has dealt with it, the assistant may ask again.
      expect(mergeContext).toHaveBeenCalledWith('c1', {
        unansweredHandoverAt: undefined,
        strugglingTurns: 0,
      });
    });
  });
});
