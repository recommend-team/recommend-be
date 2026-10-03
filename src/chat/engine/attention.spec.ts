import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EngineService } from './engine.service';
import { ConversationService } from '../conversation/conversation.service';
import { ChannelRegistry } from '../transport/channel.registry';
import { DiscoveryService } from './discovery/discovery.service';
import { CheckoutFlow } from './flows/checkout.flow';
import { HandoverService } from './handover.service';
import { ORDERING_PORT } from '../ports/ordering.port';
import { Conversation } from '../conversation/entities/conversation.entity';
import {
  ChatChannel,
  ConversationState,
  MessageAuthor,
} from '../enums/chat.enums';

const buyerSaid = (text: string) => ({ author: MessageAuthor.BUYER, text });
const botSaid = (text: string) => ({ author: MessageAuthor.ASSISTANT, text });

const answered = {
  messages: [{ text: 'Here is what I found:' }],
  resolvedAreaId: null,
  usedFallback: false,
  modelFailed: false,
  foundNothing: false,
  handover: null,
};

/**
 * What the assistant does when it is not coping.
 *
 * Two strengths of signal. A *flag* sorts the conversation up the admin queue and alerts
 * once. A *handover* is louder: the assistant tells the buyer it is checking, goes quiet,
 * and waits for an admin — until `CHAT_HANDOVER_WAIT_MINUTES` pass and it answers again.
 */
describe('attention and handover', () => {
  let service: EngineService;
  let flagForAttention: jest.Mock;
  let mergeContext: jest.Mock;
  let discover: jest.Mock;
  let handover: {
    shouldStaySilent: jest.Mock;
    announceBuyerWaiting: jest.Mock;
    awaitingTeammate: jest.Mock;
    requestHandover: jest.Mock;
  };
  let checkoutHandle: jest.Mock;
  let history: { id?: string; author: MessageAuthor; text: string }[];
  let getHistory: jest.Mock;

  const conversation = (over: Partial<Conversation> = {}): Conversation =>
    ({
      id: 'c1',
      channel: ChatChannel.PWA,
      channelAddress: 'session-1',
      state: ConversationState.DISCOVERY,
      areaId: null,
      context: {},
      needsAttentionAt: null,
      attentionReason: null,
      heldByAdminId: null,
      handoverRequestedAt: null,
      ...over,
    }) as Conversation;

  beforeEach(async () => {
    history = [];
    getHistory = jest.fn(() => Promise.resolve(history));
    flagForAttention = jest.fn();
    mergeContext = jest.fn();
    discover = jest.fn().mockResolvedValue(answered);
    checkoutHandle = jest.fn().mockResolvedValue([{ text: 'Your phone?' }]);
    handover = {
      shouldStaySilent: jest.fn().mockResolvedValue(false),
      announceBuyerWaiting: jest.fn(),
      awaitingTeammate: jest.fn().mockResolvedValue('none'),
      requestHandover: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EngineService,
        { provide: ConfigService, useValue: { get: () => 12 } },
        {
          provide: ConversationService,
          useValue: {
            recordInbound: jest.fn().mockResolvedValue({ id: 'in-1' }),
            recordOutbound: jest
              .fn()
              .mockResolvedValue({ id: 'out-1', createdAt: new Date() }),
            mergeContext,
            getHistory,
            setArea: jest.fn(),
            flagForAttention,
          },
        },
        { provide: ChannelRegistry, useValue: { send: jest.fn() } },
        { provide: DiscoveryService, useValue: { discover } },
        {
          provide: CheckoutFlow,
          useValue: { start: jest.fn(), handle: checkoutHandle },
        },
        { provide: HandoverService, useValue: handover },
        { provide: ORDERING_PORT, useValue: {} },
      ],
    }).compile();

    service = module.get(EngineService);
  });

  const say = async (text: string, over: Partial<Conversation> = {}) =>
    (
      await service.handleInbound({ conversation: conversation(over), text })
    ).map((reply) => reply.text);

  const flagReason = (): string => {
    const [, reason] = (flagForAttention.mock.calls[0] ?? []) as string[];
    return reason ?? '';
  };

  // ─── The flag ───────────────────────────────────────────────────────────────

  describe('the flag', () => {
    it('stays quiet when the assistant answered normally', async () => {
      await say('jollof rice');

      expect(flagForAttention).not.toHaveBeenCalled();
      expect(handover.requestHandover).not.toHaveBeenCalled();
    });

    it('raises a hand when the model failed and keyword search stood in', async () => {
      discover.mockResolvedValue({
        ...answered,
        usedFallback: true,
        modelFailed: true,
      });

      await say('jollof rice');

      expect(flagReason()).toMatch(/could not find/i);
    });

    it('does not count keyword search on a deployment with no API key', async () => {
      // A supported mode (README). Counting it would flag every conversation there.
      discover.mockResolvedValue({ ...answered, usedFallback: true });

      await say('jollof rice');

      expect(flagForAttention).not.toHaveBeenCalled();
    });

    it('raises a hand — but does not hand over — when one search finds nothing', async () => {
      // A single empty search is ordinary. Handing over on it would bury the admins.
      discover.mockResolvedValue({ ...answered, foundNothing: true });

      const replies = await say('ostrich egg');

      expect(flagReason()).toMatch(/could not find/i);
      expect(handover.requestHandover).not.toHaveBeenCalled();
      expect(replies).toEqual(['Here is what I found:']);
    });

    it('keeps the first reason rather than the newest', async () => {
      // The queue is ordered by how long someone has been stuck, so re-stamping would push
      // the most-stuck buyer to the back of it.
      discover.mockResolvedValue({ ...answered, foundNothing: true });

      await say('still nothing', {
        needsAttentionAt: new Date(),
        attentionReason: 'Nothing matched what they asked for',
      });

      expect(flagForAttention).not.toHaveBeenCalled();
    });
  });

  // ─── Handing over ───────────────────────────────────────────────────────────

  describe('handing over', () => {
    it('hands over when the buyer asks the same thing again', async () => {
      // The clearest sign a buyer is not being understood: they rephrase nothing and
      // simply send it again.
      history = [
        buyerSaid('do you deliver to yaba'),
        botSaid('Here is what I found:'),
      ];

      const replies = await say('Do you deliver to Yaba?');

      expect(handover.requestHandover).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c1' }),
        'The buyer asked the same thing twice',
      );
      expect(replies).toEqual(['Let me check on that for you — one moment.']);
    });

    it('does not mistake the message being answered for a repeat', async () => {
      // It is recorded before discovery runs, so it is the newest row of history. Left in,
      // every message would read as "asked the same thing twice" — caught by a live run.
      history = [
        { id: 'earlier', ...buyerSaid('hi') },
        { id: 'reply', ...botSaid('Hello! What are you looking for?') },
        { id: 'in-1', ...buyerSaid('jollof rice') },
      ] as typeof history;

      const replies = await say('jollof rice');

      expect(handover.requestHandover).not.toHaveBeenCalled();
      expect(flagForAttention).not.toHaveBeenCalled();
      expect(replies).toEqual(['Here is what I found:']);
    });

    it('gives the model history without the message it is answering, at the configured depth', async () => {
      history = [
        { id: 'earlier', ...buyerSaid('hi') },
        { id: 'in-1', ...buyerSaid('jollof rice') },
      ] as typeof history;

      await say('jollof rice');

      const [request] = discover.mock.calls[0] as [
        { history: { id: string }[] },
      ];
      expect(request.history.map((message) => message.id)).toEqual(['earlier']);
      expect(getHistory).toHaveBeenCalledWith('c1', { limit: 13 });
    });

    it('does not count a repeat further back than the last thing they said', async () => {
      history = [
        buyerSaid('do you deliver to yaba'),
        botSaid('Here is what I found:'),
        buyerSaid('how much is jollof'),
        botSaid('It is shown below'),
      ];

      await say('do you deliver to yaba');

      // Coming back to a question after a detour is ordinary conversation, not confusion.
      expect(handover.requestHandover).not.toHaveBeenCalled();
    });

    it('ignores a repeated one-word reply', async () => {
      history = [buyerSaid('yes'), botSaid('Which one?')];

      await say('yes');

      expect(handover.requestHandover).not.toHaveBeenCalled();
    });

    it('hands over on the second struggling turn in a row', async () => {
      discover.mockResolvedValue({ ...answered, foundNothing: true });

      const replies = await say('ostrich egg', {
        context: { strugglingTurns: 1 },
      });

      expect(handover.requestHandover).toHaveBeenCalledWith(
        expect.anything(),
        'The assistant could not help twice in a row',
      );
      expect(replies).toEqual(['Let me check on that for you — one moment.']);
    });

    it('counts struggling turns, and a turn that helps starts the count again', async () => {
      discover.mockResolvedValue({ ...answered, foundNothing: true });
      await say('ostrich egg');
      expect(mergeContext).toHaveBeenLastCalledWith('c1', {
        strugglingTurns: 1,
      });

      discover.mockResolvedValue(answered);
      await say('jollof', { context: { strugglingTurns: 1 } });
      expect(mergeContext).toHaveBeenLastCalledWith('c1', {
        strugglingTurns: 0,
      });
    });

    it('hands over when the model asks for a teammate, with its reason', async () => {
      discover.mockResolvedValue({
        ...answered,
        messages: [{ text: '' }],
        handover: 'Asking where order REC-1A2B is',
      });

      const replies = await say('where is my order REC-1A2B');

      expect(handover.requestHandover).toHaveBeenCalledWith(
        expect.anything(),
        'Asking where order REC-1A2B is',
      );
      expect(replies).toEqual(['Let me check on that for you — one moment.']);
    });

    it('is honest when it cannot hand over what the model asked for', async () => {
      // Refused — most often because the last handover here went unanswered.
      handover.requestHandover.mockResolvedValue(false);
      discover.mockResolvedValue({
        ...answered,
        messages: [{ text: '' }],
        handover: 'Wants a refund',
      });

      const replies = await say('I want my money back');

      expect(replies[0]).toMatch(/can't sort that out from here/i);
      expect(flagForAttention).not.toHaveBeenCalled();
    });

    it('falls back to the flag when a rule-based handover is refused', async () => {
      handover.requestHandover.mockResolvedValue(false);
      history = [
        buyerSaid('do you deliver to yaba'),
        botSaid('Here is what I found:'),
      ];

      const replies = await say('do you deliver to yaba');

      expect(flagReason()).toMatch(/same thing twice/i);
      expect(replies).toEqual(['Here is what I found:']);
    });

    it('never hands over from the scripted checkout', async () => {
      // A person stepping into the middle of it breaks the state machine.
      history = [buyerSaid('ada'), botSaid('What number can we reach you on?')];

      const replies = await say('ada', {
        state: ConversationState.COLLECTING_PHONE,
      });

      expect(handover.requestHandover).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
      expect(replies).toEqual(['Your phone?']);
    });
  });

  // ─── Waiting, and giving up waiting ─────────────────────────────────────────

  describe('waiting for a teammate', () => {
    it('stays silent inside the wait', async () => {
      handover.awaitingTeammate.mockResolvedValue('waiting');

      const replies = await say('hello?');

      expect(replies).toEqual([]);
      expect(discover).not.toHaveBeenCalled();
    });

    it('answers again once nobody came, apologising first', async () => {
      handover.awaitingTeammate.mockResolvedValue('expired');

      const replies = await say('jollof rice');

      expect(replies).toEqual([
        'Sorry to keep you waiting.',
        'Here is what I found:',
      ]);
    });

    it('a person already answering outranks the wait', async () => {
      handover.shouldStaySilent.mockResolvedValue(true);

      const replies = await say('anything');

      expect(replies).toEqual([]);
      expect(handover.awaitingTeammate).not.toHaveBeenCalled();
      expect(flagForAttention).not.toHaveBeenCalled();
    });
  });
});
