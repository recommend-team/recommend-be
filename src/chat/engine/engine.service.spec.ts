import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EngineService } from './engine.service';
import { ConversationService } from '../conversation/conversation.service';
import { ChannelRegistry } from '../transport/channel.registry';
import { Conversation } from '../conversation/entities/conversation.entity';
import {
  ChatChannel,
  ConversationState,
  MessageAuthor,
} from '../enums/chat.enums';
import { DiscoveryService } from './discovery/discovery.service';
import { CheckoutFlow } from './flows/checkout.flow';
import { HandoverService } from './handover.service';
import { ORDERING_PORT } from '../ports/ordering.port';

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
  let discovery: {
    discover: jest.Mock;
    hasModel: jest.Mock;
    answerAside: jest.Mock;
  };
  let checkoutFlow: {
    start: jest.Mock;
    handle: jest.Mock;
    addAddOns: jest.Mock;
    repeatQuestion: jest.Mock;
  };
  let handover: {
    shouldStaySilent: jest.Mock;
    announceBuyerWaiting: jest.Mock;
    requestHandover: jest.Mock;
  };

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
    handover = {
      shouldStaySilent: jest.fn().mockResolvedValue(false),
      announceBuyerWaiting: jest.fn(),
      requestHandover: jest.fn().mockResolvedValue(true),
    };
    discovery = {
      // No model by default — the keyword-only deployment. Tests that need one say so.
      hasModel: jest.fn().mockReturnValue(false),
      answerAside: jest.fn().mockResolvedValue(null),
      discover: jest.fn().mockResolvedValue({
        messages: [{ text: 'Here is what I found:' }],
        resolvedAreaId: null,
        usedFallback: false,
      }),
    };

    checkoutFlow = {
      start: jest.fn().mockResolvedValue([{ text: 'What name should I use?' }]),
      handle: jest.fn().mockResolvedValue([{ text: 'Got it.' }]),
      addAddOns: jest.fn(),
      repeatQuestion: jest
        .fn()
        .mockResolvedValue([{ text: 'What is the full delivery address?' }]),
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
        { provide: ConversationService, useValue: conversations },
        { provide: ChannelRegistry, useValue: registry },
        { provide: DiscoveryService, useValue: discovery },
        { provide: CheckoutFlow, useValue: checkoutFlow },
        { provide: HandoverService, useValue: handover },
        {
          provide: ORDERING_PORT,
          useValue: { listOrders: jest.fn(), completeOrder: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<EngineService>(EngineService);
  });

  describe('a question in the middle of checkout', () => {
    const atAddress = {
      ...conversation,
      state: ConversationState.COLLECTING_ADDRESS,
    } as Conversation;
    const said = async (text: string) =>
      (await service.handleInbound({ conversation: atAddress, text })).map(
        (reply) => reply.text,
      );

    it('answers "why do you need my details?", then asks again — the screenshot', async () => {
      const replies = await said(
        'what do you need thesed etails for?, my phone, email and address too',
      );

      expect(replies[0]).toMatch(/^Fair question. Your name and phone number/);
      expect(replies[0]).toMatch(/email is optional/);
      expect(replies[1]).toBe('What is the full delivery address?');
      // Never taken as the address.
      expect(checkoutFlow.handle).not.toHaveBeenCalled();
    });

    it('answers the earlier question on "i asked a question"', async () => {
      conversations.getHistory.mockResolvedValue([
        {
          id: 'm1',
          author: MessageAuthor.BUYER,
          text: 'why do you need my phone number',
        },
        { id: 'm2', author: MessageAuthor.ASSISTANT, text: 'Could you add…' },
      ]);

      const replies = await said('i asked a question');

      expect(replies[0]).toMatch(/^Sorry about that. Fair question./);
      expect(replies[1]).toBe('What is the full delivery address?');
      expect(checkoutFlow.handle).not.toHaveBeenCalled();
    });

    it('asks what they want to know when there is no earlier question', async () => {
      const replies = await said('i asked a question');

      expect(replies[0]).toBe(
        'Sorry about that — what would you like to know?',
      );
      expect(checkoutFlow.handle).not.toHaveBeenCalled();
    });

    it('answers any other question from what James knows', async () => {
      discovery.answerAside.mockResolvedValue(
        'Delivery usually takes 20 to 30 minutes.',
      );

      const replies = await said('how long will delivery take?');

      expect(discovery.answerAside).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'how long will delivery take?' }),
      );
      expect(replies).toEqual([
        'Delivery usually takes 20 to 30 minutes.',
        'What is the full delivery address?',
      ]);
    });

    it('says so when it cannot answer, and still asks again', async () => {
      const replies = await said('can you make it extra spicy?');

      expect(replies[0]).toMatch(/^I'm not sure about that one/);
      expect(replies[1]).toBe('What is the full delivery address?');
    });

    it('greets back, then asks again', async () => {
      const replies = await said('hello');

      expect(replies[0]).toContain("I'm James from Recommend");
      expect(replies[1]).toBe('What is the full delivery address?');
      expect(checkoutFlow.handle).not.toHaveBeenCalled();
    });

    it('answers a question asked at the extras card, then offers the card again', async () => {
      checkoutFlow.repeatQuestion.mockResolvedValue([
        {
          text: 'Would you like anything to go with it? Pick below, or tap No, thanks.',
        },
      ]);
      discovery.answerAside.mockResolvedValue(
        'Delivery usually takes 20 to 30 minutes.',
      );

      const replies = (
        await service.handleInbound({
          conversation: {
            ...conversation,
            state: ConversationState.OFFERING_ADDONS,
          } as Conversation,
          text: 'how long will delivery take?',
        })
      ).map((reply) => reply.text);

      expect(replies[0]).toBe('Delivery usually takes 20 to 30 minutes.');
      expect(replies[1]).toMatch(/Pick below/);
      expect(checkoutFlow.handle).not.toHaveBeenCalled();
    });

    it('takes an answer as an answer', async () => {
      await said('12 Allen Avenue, Ikeja');

      expect(checkoutFlow.handle).toHaveBeenCalledWith(
        atAddress,
        '12 Allen Avenue, Ikeja',
      );
    });
  });

  describe('the add-on card', () => {
    it('records what was added as the buyer’s turn, then carries on', async () => {
      checkoutFlow.addAddOns.mockResolvedValue({
        added: '2 × Bottled water',
        replies: [{ text: 'What name should I use?' }],
      });

      await service.addAddOns(conversation, [{ productId: 'w1', quantity: 2 }]);

      expect(conversations.recordInbound).toHaveBeenCalledWith({
        conversationId: 'c1',
        text: 'Add 2 × Bottled water',
      });
      expect(registry.send).toHaveBeenCalled();
    });

    it('records "No, thanks" when nothing was picked', async () => {
      checkoutFlow.addAddOns.mockResolvedValue({
        added: null,
        replies: [{ text: 'What name should I use?' }],
      });

      await service.addAddOns(conversation, []);

      expect(conversations.recordInbound).toHaveBeenCalledWith({
        conversationId: 'c1',
        text: 'No, thanks',
      });
    });

    it('leaves no trace for a stale card', async () => {
      checkoutFlow.addAddOns.mockResolvedValue({ added: null, replies: [] });

      await service.addAddOns(conversation, [{ productId: 'w1', quantity: 1 }]);

      expect(conversations.recordInbound).not.toHaveBeenCalled();
      expect(registry.send).not.toHaveBeenCalled();
    });
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

  it('answers a greeting itself, by name, when there is no model', async () => {
    await service.handleInbound({ conversation, text: 'Hello' });

    expect(discovery.discover).not.toHaveBeenCalled();
    expect(firstReplyText()).toContain("I'm James from Recommend");
    expect(firstReplyText()).toContain('What are you looking for');
  });

  describe('a buyer who has bought before', () => {
    const returning = () =>
      ({
        ...conversation,
        context: {
          profile: { name: 'Ada Obi', phone: '+2348012345678' },
          lastPaidAt: '2026-10-01T10:00:00.000Z',
        },
      }) as typeof conversation;

    it('is greeted by first name', async () => {
      await service.handleInbound({ conversation: returning(), text: 'Hello' });

      expect(firstReplyText()).toBe('Hi Ada! What can I get you today?');
    });

    it('is named to the model, so it greets them too', async () => {
      discovery.hasModel.mockReturnValue(true);

      await service.handleInbound({ conversation: returning(), text: 'Hello' });

      expect(discovery.discover).toHaveBeenCalledWith(
        expect.objectContaining({ buyerFirstName: 'Ada' }),
      );
    });

    it('is not assumed from a name typed into a checkout never paid for', async () => {
      await service.handleInbound({
        conversation: {
          ...conversation,
          context: { profile: { name: 'Ada Obi' } },
        } as typeof conversation,
        text: 'Hello',
      });

      expect(firstReplyText()).toContain("I'm James from Recommend");
    });
  });

  it('lets the model answer a greeting when there is one — a person, not a fixed line', async () => {
    discovery.hasModel.mockReturnValue(true);

    await service.handleInbound({ conversation, text: 'How far' });

    expect(discovery.discover).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'How far' }),
    );
  });

  it('introduces itself by name in the first greeting', async () => {
    const greeting = await service.greet(conversation);

    expect(greeting.text).toMatch(/^Hi! I'm James from Recommend\./);
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

  describe('when an admin is answering', () => {
    beforeEach(() => {
      handover.shouldStaySilent.mockResolvedValue(true);
    });

    it('still records what the buyer said', async () => {
      // The whole point of taking over is to read them. Suppressing the reply must never
      // suppress the message.
      await service.handleInbound({ conversation, text: 'this is broken' });

      expect(conversations.recordInbound).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'this is broken' }),
      );
    });

    it('tells the admin there is someone waiting', async () => {
      // The assistant's silence is only safe if the person holding it hears the buyer.
      await service.handleInbound({ conversation, text: 'hello?' });

      expect(handover.announceBuyerWaiting).toHaveBeenCalledWith(
        conversation,
        'hello?',
      );
    });

    it('says nothing at all', async () => {
      const replies = await service.handleInbound({
        conversation,
        text: 'this is broken',
      });

      expect(replies).toEqual([]);
      expect(conversations.recordOutbound).not.toHaveBeenCalled();
      expect(registry.send).not.toHaveBeenCalled();
    });

    it('spends nothing on the model', async () => {
      await service.handleInbound({ conversation, text: 'find me jollof' });

      expect(discovery.discover).not.toHaveBeenCalled();
    });

    it('does not run the checkout flow either', async () => {
      await service.handleInbound({ conversation, text: '08012345678' });

      expect(checkoutFlow.handle).not.toHaveBeenCalled();
    });

    it('answers again the moment the hold lapses', async () => {
      handover.shouldStaySilent.mockResolvedValue(false);

      const replies = await service.handleInbound({
        conversation,
        text: 'still there?',
      });

      expect(replies).toHaveLength(1);
      expect(discovery.discover).toHaveBeenCalled();
    });
  });
});
