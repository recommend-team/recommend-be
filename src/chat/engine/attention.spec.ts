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
 * once. A *handover* puts the buyer in front of a person — only ever with their agreement,
 * and told plainly. The assistant keeps chatting until an admin takes the chat.
 */
describe('attention and handover', () => {
  let service: EngineService;
  let flagForAttention: jest.Mock;
  let mergeContext: jest.Mock;
  let discover: jest.Mock;
  let handover: {
    shouldStaySilent: jest.Mock;
    announceBuyerWaiting: jest.Mock;
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
      requestHandover: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EngineService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'chat.assistantName' ? 'James' : 12),
          },
        },
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
        {
          provide: DiscoveryService,
          useValue: { discover, hasModel: () => true },
        },
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

  // ─── Asking first ───────────────────────────────────────────────────────────

  const OFFER = /Would you like me to bring in someone from our team\?/;
  const HANDED_OVER = /passed this chat to our team/;

  /** The chips on the last reply, if it offered a person. */
  const sayWithPayload = async (
    text: string,
    over: Partial<Conversation> = {},
  ) => service.handleInbound({ conversation: conversation(over), text });

  describe('offering a person', () => {
    it('offers — never hands over — on the second unhelpful turn in a row', async () => {
      discover.mockResolvedValue({ ...answered, foundNothing: true });

      const replies = await sayWithPayload('ostrich egg', {
        context: { strugglingTurns: 1 },
      });

      expect(handover.requestHandover).not.toHaveBeenCalled();
      // What discovery said, then the question — with the answers as chips.
      expect(replies[0].text).toBe('Here is what I found:');
      expect(replies[1].text).toMatch(OFFER);
      expect(replies[1].payload).toEqual({
        kind: 'choices',
        data: {
          purpose: 'teammate',
          options: [
            { id: 'yes', label: 'Yes, talk to a person' },
            { id: 'no', label: 'No, keep chatting' },
          ],
        },
      });
      // Remembered, with the reason, so a "yes" next can hand over.
      expect(mergeContext).toHaveBeenCalledWith('c1', {
        teammateOffered: 'The assistant could not help twice in a row',
        strugglingTurns: 0,
      });
    });

    it('does not offer after a single unhelpful turn', async () => {
      discover.mockResolvedValue({ ...answered, foundNothing: true });

      const replies = await say('ostrich egg');

      expect(replies).toEqual(['Here is what I found:']);
    });

    it('counts the buyer sending the same thing again as unhelpful', async () => {
      history = [
        buyerSaid('do you deliver to yaba'),
        botSaid('Here is what I found:'),
      ];

      const replies = await say('Do you deliver to Yaba?', {
        context: { strugglingTurns: 1 },
      });

      expect(handover.requestHandover).not.toHaveBeenCalled();
      expect(replies[1]).toMatch(OFFER);
    });

    it('does not offer again while the team is already on its way', async () => {
      discover.mockResolvedValue({ ...answered, foundNothing: true });

      const replies = await say('ostrich egg', {
        context: { strugglingTurns: 1 },
        handoverRequestedAt: new Date(),
      });

      expect(replies).toEqual(['Here is what I found:']);
    });

    it('counts unhelpful turns, and a turn that helps starts the count again', async () => {
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

    it('never counts a model outage on its own — the buyer still got an answer', async () => {
      discover.mockResolvedValue({
        ...answered,
        usedFallback: true,
        modelFailed: true,
      });

      const replies = await say('jollof rice', {
        context: { strugglingTurns: 1 },
      });

      expect(replies).toEqual(['Here is what I found:']);
    });

    it('answers small talk itself when the model is down — the staging outage', async () => {
      // "who are you?" through keyword search "found nothing", twice, and the buyer was
      // handed over into silence.
      discover.mockResolvedValue({
        ...answered,
        messages: [{ text: 'I could not find anything matching "who".' }],
        usedFallback: true,
        modelFailed: true,
        foundNothing: true,
      });

      const replies = await say('who are you?', {
        context: { strugglingTurns: 1 },
      });

      expect(replies).toEqual([
        "I'm James, Recommend's virtual assistant. I help you find and order from vendors near you — what are you looking for?",
      ]);
      expect(handover.requestHandover).not.toHaveBeenCalled();
    });

    it('greets properly when the model is down', async () => {
      discover.mockResolvedValue({
        ...answered,
        usedFallback: true,
        modelFailed: true,
        foundNothing: true,
      });

      const replies = await say('hello');

      expect(replies[0]).toMatch(/^Hello, I'm James from Recommend/);
    });

    it('offers a person when the model says only the team can help', async () => {
      discover.mockResolvedValue({
        ...answered,
        messages: [{ text: '' }],
        handover: 'Wants a refund for REC-1A2B',
        buyerAskedForPerson: false,
      });

      const replies = await say('I want my money back');

      expect(handover.requestHandover).not.toHaveBeenCalled();
      expect(replies).toEqual([
        'Someone from our team is best placed to help with that. Would you like me to bring them in?',
      ]);
      expect(mergeContext).toHaveBeenCalledWith('c1', {
        teammateOffered: 'Wants a refund for REC-1A2B',
        strugglingTurns: 0,
      });
    });

    it('sends nothing the model half-said once it asks for the team', async () => {
      // When the model asks for the team, its turn ends — nothing it half-said is sent.
      discover.mockResolvedValue({
        ...answered,
        messages: [{ text: 'Let me know what you are looking for.' }],
        handover: 'Complaint about a late order',
        buyerAskedForPerson: false,
      });

      const replies = await say('my food is late and cold');

      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatch(/Would you like me to bring them in\?/);
    });
  });

  describe('answering the offer', () => {
    const offered = { context: { teammateOffered: 'Wants a refund' } };

    it('hands over on yes, with the reason it offered', async () => {
      const replies = await say('Yes, talk to a person', offered);

      expect(handover.requestHandover).toHaveBeenCalledWith(
        expect.anything(),
        'Wants a refund',
      );
      expect(replies[0]).toMatch(HANDED_OVER);
      expect(discover).not.toHaveBeenCalled();
    });

    it('takes a typed "ok" as a yes', async () => {
      await say('ok', offered);

      expect(handover.requestHandover).toHaveBeenCalled();
    });

    it('keeps chatting on no', async () => {
      const replies = await say('No, keep chatting', offered);

      expect(handover.requestHandover).not.toHaveBeenCalled();
      expect(replies).toEqual([
        'No problem — what would you like to try next?',
      ]);
    });

    it('closes the offer whatever the answer, so a later "yes" summons nobody', async () => {
      const replies = await say('jollof rice in yaba', offered);

      expect(mergeContext).toHaveBeenCalledWith('c1', {
        teammateOffered: undefined,
      });
      expect(handover.requestHandover).not.toHaveBeenCalled();
      expect(replies).toEqual(['Here is what I found:']);
    });

    it('a plain "yes" with no offer open is just a message', async () => {
      await say('yes');

      expect(handover.requestHandover).not.toHaveBeenCalled();
      expect(discover).toHaveBeenCalled();
    });
  });

  // ─── Asked for ──────────────────────────────────────────────────────────────

  describe('a buyer asking for a person', () => {
    it.each([
      'I want to speak to someone',
      'can I talk to a human',
      'customer care',
      'Let me talk to your manager please',
      'connect me with customer service',
      'I need an agent',
    ])('hands over at once on "%s", and says so', async (text) => {
      const replies = await say(text);

      expect(handover.requestHandover).toHaveBeenCalledWith(
        expect.anything(),
        'The buyer asked to speak to someone',
      );
      expect(replies).toEqual([
        "I've passed this chat to our team — someone will reply here shortly. You can keep chatting with me meanwhile.",
      ]);
      expect(discover).not.toHaveBeenCalled();
    });

    it.each([
      'do you have someone that sells suya',
      'is the team open on sunday',
    ])('does not mistake "%s" for asking for a person', async (text) => {
      await say(text);

      expect(handover.requestHandover).not.toHaveBeenCalled();
    });

    it('hands over when the model hears the buyer ask for a person', async () => {
      discover.mockResolvedValue({
        ...answered,
        messages: [{ text: '' }],
        handover: 'Wants someone to look at order REC-1A2B',
        buyerAskedForPerson: true,
      });

      const replies = await say('can someone look at my order REC-1A2B');

      expect(handover.requestHandover).toHaveBeenCalledWith(
        expect.anything(),
        'Wants someone to look at order REC-1A2B',
      );
      expect(replies[0]).toMatch(HANDED_OVER);
    });

    it('works mid-checkout too', async () => {
      const replies = await say('let me talk to customer care', {
        state: ConversationState.COLLECTING_PHONE,
      });

      expect(handover.requestHandover).toHaveBeenCalled();
      expect(checkoutHandle).not.toHaveBeenCalled();
      expect(replies[0]).toMatch(HANDED_OVER);
    });

    it('says the team already knows, when they do', async () => {
      const replies = await say('I want to speak to someone', {
        handoverRequestedAt: new Date(),
      });

      expect(handover.requestHandover).not.toHaveBeenCalled();
      expect(replies[0]).toMatch(/already let our team know/);
    });

    it('is honest when it cannot bring the team in', async () => {
      handover.requestHandover.mockResolvedValue(false);

      const replies = await say('I want to speak to someone');

      expect(replies[0]).toMatch(/can't bring the team in just now/);
    });
  });

  // ─── History ────────────────────────────────────────────────────────────────

  describe('history', () => {
    it('does not mistake the message being answered for a repeat', async () => {
      // It is recorded before discovery runs, so it is the newest row of history. Left in,
      // every message would read as "asked the same thing twice" — caught by a live run.
      history = [
        { id: 'earlier', ...buyerSaid('hi') },
        { id: 'reply', ...botSaid('Hello! What are you looking for?') },
        { id: 'in-1', ...buyerSaid('jollof rice') },
      ] as typeof history;

      const replies = await say('jollof rice');

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
      expect(mergeContext).not.toHaveBeenCalled();
    });

    it('ignores a repeated one-word reply', async () => {
      history = [buyerSaid('ok'), botSaid('Which one?')];

      await say('ok');

      expect(mergeContext).not.toHaveBeenCalled();
    });

    it('never offers from the scripted checkout', async () => {
      // A repeat mid-checkout is the flow re-asking, not the assistant failing.
      history = [buyerSaid('ada'), botSaid('What number can we reach you on?')];

      const replies = await say('ada', {
        state: ConversationState.COLLECTING_PHONE,
      });

      expect(discover).not.toHaveBeenCalled();
      expect(replies).toEqual(['Your phone?']);
    });
  });

  // ─── Waiting ────────────────────────────────────────────────────────────────

  describe('waiting for the team', () => {
    it('keeps answering while nobody has taken the chat yet', async () => {
      const replies = await say('jollof rice', {
        handoverRequestedAt: new Date(),
      });

      expect(replies).toEqual(['Here is what I found:']);
    });

    it('goes quiet once an admin takes it', async () => {
      handover.shouldStaySilent.mockResolvedValue(true);

      const replies = await say('anything', {
        handoverRequestedAt: new Date(),
      });

      expect(replies).toEqual([]);
      expect(discover).not.toHaveBeenCalled();
      expect(flagForAttention).not.toHaveBeenCalled();
    });
  });
});
