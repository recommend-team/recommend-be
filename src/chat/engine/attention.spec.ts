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

/**
 * Raising a hand when the assistant is not coping.
 *
 * Nothing here pages anyone — it sorts the admin queue. The point is that the signals
 * cost nothing: all three are already known by the time the reply is composed.
 */
describe('flagging a conversation for attention', () => {
  let service: EngineService;
  let flagForAttention: jest.Mock;
  let discover: jest.Mock;
  let history: { author: MessageAuthor; text: string }[];

  const conversation = (over: Partial<Conversation> = {}): Conversation =>
    ({
      id: 'c1',
      channel: ChatChannel.PWA,
      channelAddress: 'session-1',
      state: ConversationState.DISCOVERY,
      areaId: null,
      needsAttentionAt: null,
      attentionReason: null,
      ...over,
    }) as Conversation;

  beforeEach(async () => {
    history = [];
    flagForAttention = jest.fn();
    discover = jest.fn().mockResolvedValue({
      messages: [{ text: 'Here is what I found:' }],
      resolvedAreaId: null,
      usedFallback: false,
      foundNothing: false,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EngineService,
        {
          provide: ConfigService,
          useValue: { get: () => 12 },
        },
        {
          provide: ConversationService,
          useValue: {
            recordInbound: jest.fn().mockResolvedValue({ id: 'in-1' }),
            recordOutbound: jest
              .fn()
              .mockResolvedValue({ id: 'out-1', createdAt: new Date() }),
            mergeContext: jest.fn(),
            getHistory: jest.fn(() => Promise.resolve(history)),
            setArea: jest.fn(),
            flagForAttention,
          },
        },
        { provide: ChannelRegistry, useValue: { send: jest.fn() } },
        { provide: DiscoveryService, useValue: { discover } },
        {
          provide: CheckoutFlow,
          useValue: { start: jest.fn(), handle: jest.fn() },
        },
        {
          provide: HandoverService,
          useValue: { shouldStaySilent: jest.fn().mockResolvedValue(false) },
        },
        { provide: ORDERING_PORT, useValue: {} },
      ],
    }).compile();

    service = module.get(EngineService);
  });

  const reasonGiven = (): string => {
    const [, reason] = (flagForAttention.mock.calls[0] ?? []) as string[];
    return reason ?? '';
  };

  it('stays quiet when the assistant answered normally', async () => {
    await service.handleInbound({
      conversation: conversation(),
      text: 'jollof rice',
    });

    expect(flagForAttention).not.toHaveBeenCalled();
  });

  it('raises a hand when the model was skipped for keyword search', async () => {
    discover.mockResolvedValue({
      messages: [{ text: 'Here is what I found:' }],
      resolvedAreaId: null,
      usedFallback: true,
      foundNothing: false,
    });

    await service.handleInbound({
      conversation: conversation(),
      text: 'jollof rice',
    });

    expect(reasonGiven()).toMatch(/keyword search/i);
  });

  it('raises a hand when nothing matched', async () => {
    discover.mockResolvedValue({
      messages: [{ text: 'I could not find that.' }],
      resolvedAreaId: null,
      usedFallback: false,
      foundNothing: true,
    });

    await service.handleInbound({
      conversation: conversation(),
      text: 'ostrich egg',
    });

    expect(reasonGiven()).toMatch(/nothing matched/i);
  });

  it('raises a hand when the buyer asks the same thing again', async () => {
    // The clearest sign a buyer is not being understood: they rephrase nothing and
    // simply send it again.
    history = [
      buyerSaid('do you deliver to yaba'),
      botSaid('Here is what I found:'),
    ];

    await service.handleInbound({
      conversation: conversation(),
      text: 'Do you deliver to Yaba?',
    });

    expect(reasonGiven()).toMatch(/same thing twice/i);
  });

  it('does not count a repeat further back than the last thing they said', async () => {
    history = [
      buyerSaid('do you deliver to yaba'),
      botSaid('Here is what I found:'),
      buyerSaid('how much is jollof'),
      botSaid('₦3,000'),
    ];

    await service.handleInbound({
      conversation: conversation(),
      text: 'do you deliver to yaba',
    });

    // Coming back to a question after a detour is ordinary conversation, not confusion.
    expect(flagForAttention).not.toHaveBeenCalled();
  });

  it('ignores a repeated one-word reply', async () => {
    history = [buyerSaid('yes'), botSaid('Which one?')];

    await service.handleInbound({ conversation: conversation(), text: 'yes' });

    expect(flagForAttention).not.toHaveBeenCalled();
  });

  it('keeps the first reason rather than the newest', async () => {
    // The queue is ordered by how long someone has been stuck, so re-stamping would push
    // the most-stuck buyer to the back of it.
    discover.mockResolvedValue({
      messages: [{ text: 'x' }],
      resolvedAreaId: null,
      usedFallback: true,
      foundNothing: false,
    });

    await service.handleInbound({
      conversation: conversation({
        needsAttentionAt: new Date(),
        attentionReason: 'Nothing matched what they asked for',
      }),
      text: 'still nothing',
    });

    expect(flagForAttention).not.toHaveBeenCalled();
  });

  it('says nothing about a conversation a person is already answering', async () => {
    const held = module_with_silence();
    await held.service.handleInbound({
      conversation: conversation(),
      text: 'anything',
    });

    expect(held.flagForAttention).not.toHaveBeenCalled();
  });

  /** A held conversation short-circuits before discovery, so nothing can flag it. */
  function module_with_silence() {
    const flag = jest.fn();
    const engine = new EngineService(
      {
        recordInbound: jest.fn().mockResolvedValue({ id: 'in-1' }),
        flagForAttention: flag,
      } as never,
      { send: jest.fn() } as never,
      { discover } as never,
      {} as never,
      { shouldStaySilent: jest.fn().mockResolvedValue(true) } as never,
      { get: () => 12 } as never,
      {} as never,
    );
    return { service: engine, flagForAttention: flag };
  }
});
