import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConversationService } from './conversation.service';
import { Conversation } from './entities/conversation.entity';
import { ChatMessage } from './entities/message.entity';
import {
  ChatChannel,
  MessageAuthor,
  MessageDirection,
} from '../enums/chat.enums';

type MockRepo = {
  find: jest.Mock;
  findOne: jest.Mock;
  count: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
};

const makeRepo = (): MockRepo => ({
  find: jest.fn(),
  findOne: jest.fn(),
  count: jest.fn(),
  create: jest.fn((input: unknown) => input),
  save: jest.fn((input: Record<string, unknown>) =>
    Promise.resolve({ id: 'generated-id', createdAt: new Date(), ...input }),
  ),
  update: jest.fn(),
});

describe('ConversationService', () => {
  let service: ConversationService;
  let conversations: MockRepo;
  let messages: MockRepo;

  beforeEach(async () => {
    conversations = makeRepo();
    messages = makeRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationService,
        { provide: getRepositoryToken(Conversation), useValue: conversations },
        { provide: getRepositoryToken(ChatMessage), useValue: messages },
      ],
    }).compile();

    service = module.get<ConversationService>(ConversationService);
  });

  describe('findOrCreate', () => {
    it('reuses the existing thread for a returning device', async () => {
      const existing = { id: 'c1' };
      conversations.findOne.mockResolvedValue(existing);

      await expect(
        service.findOrCreate(ChatChannel.PWA, 'session-1'),
      ).resolves.toBe(existing);
      expect(conversations.save).not.toHaveBeenCalled();
    });

    it('opens a new thread for an unseen device', async () => {
      conversations.findOne.mockResolvedValue(null);

      const result = await service.findOrCreate(ChatChannel.PWA, 'session-2');

      expect(conversations.save).toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          channel: ChatChannel.PWA,
          channelAddress: 'session-2',
          buyerId: null,
        }),
      );
    });

    it('scopes the lookup to the channel, so PWA and WhatsApp never collide', async () => {
      conversations.findOne.mockResolvedValue(null);

      await service.findOrCreate(ChatChannel.WHATSAPP, '+2348012345678');

      expect(conversations.findOne).toHaveBeenCalledWith({
        where: {
          channel: ChatChannel.WHATSAPP,
          channelAddress: '+2348012345678',
        },
      });
    });
  });

  describe('recordInbound', () => {
    it('persists a buyer message', async () => {
      messages.findOne.mockResolvedValue(null);

      const result = await service.recordInbound({
        conversationId: 'c1',
        text: 'I want jollof',
      });

      expect(result).toEqual(
        expect.objectContaining({
          direction: MessageDirection.INBOUND,
          author: MessageAuthor.BUYER,
          text: 'I want jollof',
        }),
      );
    });

    it('drops a retry carrying a clientMessageId we have already stored', async () => {
      messages.findOne.mockResolvedValue({ id: 'already-here' });

      const result = await service.recordInbound({
        conversationId: 'c1',
        text: 'I want jollof',
        clientMessageId: 'retry-1',
      });

      expect(result).toBeNull();
      expect(messages.save).not.toHaveBeenCalled();
    });

    it('does not look for duplicates when the client sent no id', async () => {
      await service.recordInbound({ conversationId: 'c1', text: 'hi' });
      expect(messages.findOne).not.toHaveBeenCalled();
    });

    it('stamps lastMessageAt on the conversation', async () => {
      messages.findOne.mockResolvedValue(null);

      await service.recordInbound({ conversationId: 'c1', text: 'hi' });

      expect(conversations.update).toHaveBeenCalledWith(
        { id: 'c1' },
        expect.objectContaining({ lastMessageAt: expect.any(Date) as Date }),
      );
    });
  });

  describe('recordOutbound', () => {
    it('defaults the author to the assistant', async () => {
      const result = await service.recordOutbound({
        conversationId: 'c1',
        text: 'Hello',
      });

      expect(result).toEqual(
        expect.objectContaining({
          direction: MessageDirection.OUTBOUND,
          author: MessageAuthor.ASSISTANT,
        }),
      );
    });
  });

  describe('getHistory', () => {
    it('returns oldest-first after fetching newest-first', async () => {
      messages.find.mockResolvedValue([{ id: 'newest' }, { id: 'oldest' }]);

      const result = await service.getHistory('c1');

      expect(result.map((m) => m.id)).toEqual(['oldest', 'newest']);
    });

    it('caps the page size at 100 however much is asked for', async () => {
      messages.find.mockResolvedValue([]);

      await service.getHistory('c1', { limit: 5000 });

      expect(messages.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });

    it('floors the page size at 1', async () => {
      messages.find.mockResolvedValue([]);

      await service.getHistory('c1', { limit: 0 });

      expect(messages.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 1 }),
      );
    });
  });

  describe('mergeContext', () => {
    it('merges into the existing profile instead of replacing it', async () => {
      conversations.findOne.mockResolvedValue({
        id: 'c1',
        context: { profile: { name: 'Ada' } },
      });

      await service.mergeContext('c1', {
        profile: { phone: '+2348012345678' },
      });

      expect(conversations.save).toHaveBeenCalledWith(
        expect.objectContaining({
          context: { profile: { name: 'Ada', phone: '+2348012345678' } },
        }),
      );
    });

    it('returns null for an unknown conversation', async () => {
      conversations.findOne.mockResolvedValue(null);

      await expect(service.mergeContext('missing', {})).resolves.toBeNull();
    });
  });
});
