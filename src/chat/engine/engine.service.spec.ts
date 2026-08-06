import { Test, TestingModule } from '@nestjs/testing';
import { EngineService } from './engine.service';
import { ConversationService } from '../conversation/conversation.service';
import { ChannelRegistry } from '../transport/channel.registry';
import { Conversation } from '../conversation/entities/conversation.entity';
import { ChatChannel, ConversationState } from '../enums/chat.enums';
import { DiscoveryService } from './discovery/discovery.service';

const conversation = {
  id: 'c1',
  channel: ChatChannel.PWA,
  channelAddress: 'session-1',
  areaId: null,
  state: ConversationState.DISCOVERY,
  context: {},
} as Conversation;

describe('EngineService', () => {
  let service: EngineService;
  let conversations: {
    recordInbound: jest.Mock;
    recordOutbound: jest.Mock;
    mergeContext: jest.Mock;
    getHistory: jest.Mock;
    setArea: jest.Mock;
  };
  let registry: { send: jest.Mock };
  let discovery: { discover: jest.Mock };

  beforeEach(async () => {
    conversations = {
      recordInbound: jest.fn().mockResolvedValue({ id: 'in-1' }),
      recordOutbound: jest
        .fn()
        .mockResolvedValue({ id: 'out-1', createdAt: new Date() }),
      mergeContext: jest.fn(),
      getHistory: jest.fn().mockResolvedValue([]),
      setArea: jest.fn(),
    };
    registry = { send: jest.fn().mockResolvedValue(null) };
    discovery = {
      discover: jest.fn().mockResolvedValue({
        messages: [{ text: 'Here is what I found:' }],
        resolvedAreaId: null,
        usedFallback: false,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EngineService,
        { provide: ConversationService, useValue: conversations },
        { provide: ChannelRegistry, useValue: registry },
        { provide: DiscoveryService, useValue: discovery },
      ],
    }).compile();

    service = module.get<EngineService>(EngineService);
  });

  it('persists the buyer message, then the reply, then sends it', async () => {
    await service.handleInbound({ conversation, text: 'I want jollof' });

    expect(conversations.recordInbound).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'c1', text: 'I want jollof' }),
    );
    expect(conversations.recordOutbound).toHaveBeenCalled();
    expect(registry.send).toHaveBeenCalledWith(
      ChatChannel.PWA,
      'session-1',
      expect.objectContaining({ messageId: 'out-1' }),
    );
  });

  it('persists the reply before handing it to the channel, so a dead socket loses nothing', async () => {
    const order: string[] = [];
    conversations.recordOutbound.mockImplementation(() => {
      order.push('persist');
      return Promise.resolve({ id: 'out-1', createdAt: new Date() });
    });
    registry.send.mockImplementation(() => {
      order.push('send');
      return Promise.resolve(null);
    });

    await service.handleInbound({ conversation, text: 'hello' });

    expect(order).toEqual(['persist', 'send']);
  });

  it('stays silent on a duplicate send rather than replying twice', async () => {
    conversations.recordInbound.mockResolvedValue(null);

    const replies = await service.handleInbound({
      conversation,
      text: 'I want jollof',
      clientMessageId: 'retry-1',
    });

    expect(replies).toEqual([]);
    expect(conversations.recordOutbound).not.toHaveBeenCalled();
    expect(registry.send).not.toHaveBeenCalled();
  });

  it('stores the cart snapshot as context only', async () => {
    await service.handleInbound({
      conversation,
      text: 'what is in my cart?',
      cart: { itemCount: 3, vendorCount: 2 },
    });

    expect(conversations.mergeContext).toHaveBeenCalledWith('c1', {
      lastCartSnapshot: { itemCount: 3, vendorCount: 2 },
    });
  });

  /** First thing the engine tried to persist as a reply. */
  const firstReplyText = (): string => {
    const calls = conversations.recordOutbound.mock.calls as [
      { text: string },
    ][];
    return calls[0][0].text;
  };

  it('answers a greeting without spending a model call', async () => {
    await service.handleInbound({ conversation, text: 'Hello' });

    expect(discovery.discover).not.toHaveBeenCalled();
    expect(firstReplyText()).toContain('What would you like to eat');
  });

  it('sends anything that is not a greeting to discovery', async () => {
    await service.handleInbound({ conversation, text: 'pounded yam' });

    expect(discovery.discover).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'pounded yam', areaId: null }),
    );
    expect(firstReplyText()).toBe('Here is what I found:');
  });

  it('remembers an area discovery resolved, so it is never asked twice', async () => {
    discovery.discover.mockResolvedValue({
      messages: [{ text: 'Found some places.' }],
      resolvedAreaId: 'area-yaba',
      usedFallback: false,
    });

    await service.handleInbound({ conversation, text: 'jollof in yaba' });

    expect(conversations.setArea).toHaveBeenCalledWith('c1', 'area-yaba');
  });

  it('does not rewrite the area when discovery returns the one already stored', async () => {
    const known = { ...conversation, areaId: 'area-yaba' } as Conversation;
    discovery.discover.mockResolvedValue({
      messages: [{ text: 'Found some places.' }],
      resolvedAreaId: 'area-yaba',
      usedFallback: false,
    });

    await service.handleInbound({ conversation: known, text: 'jollof' });

    expect(conversations.setArea).not.toHaveBeenCalled();
  });

  it('carries the discovery payload through to the channel', async () => {
    discovery.discover.mockResolvedValue({
      messages: [
        { text: 'Here you go:', payload: { kind: 'product_list', data: {} } },
      ],
      resolvedAreaId: null,
      usedFallback: false,
    });

    await service.handleInbound({ conversation, text: 'jollof' });

    expect(conversations.recordOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { kind: 'product_list', data: {} },
      }),
    );
  });

  it('handles an empty message without falling over', async () => {
    await service.handleInbound({ conversation, text: '   ' });

    expect(firstReplyText()).toContain("didn't catch that");
  });

  it('greets a brand-new conversation', async () => {
    const greeting = await service.greet(conversation);

    expect(greeting.text).toContain('Recommend');
    expect(registry.send).toHaveBeenCalled();
  });
});
