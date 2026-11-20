import { IsNull } from 'typeorm';
import { HandlingLogService } from './handling-log.service';
import { HandlingEndReason } from '../conversation/entities/conversation-handling.entity';

describe('HandlingLogService', () => {
  let repo: {
    findOne: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let log: HandlingLogService;
  /** Raw rows the two stats queries return, in order. */
  let rawResults: unknown[][];

  beforeEach(() => {
    rawResults = [];
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => {
        const qb: Record<string, jest.Mock> = {};
        for (const method of [
          'select',
          'addSelect',
          'where',
          'setParameter',
          'groupBy',
        ]) {
          qb[method] = jest.fn(() => qb);
        }
        qb.getRawMany = jest.fn(() =>
          Promise.resolve(rawResults.shift() ?? []),
        );
        return qb;
      }),
    };
    log = new HandlingLogService(repo as never);
  });

  it('opens a spell for whoever takes a chat', async () => {
    const waitingSince = new Date('2026-11-20T09:00:00Z');

    await log.started('c1', 'agent-1', { waitingSince });

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'c1',
        adminId: 'agent-1',
        waitingSince,
        assignedByAdminId: null,
        endedAt: null,
      }),
    );
  });

  it('does not open a second spell for someone who already has it', async () => {
    repo.findOne.mockResolvedValue({ adminId: 'agent-1' });

    await log.started('c1', 'agent-1', { waitingSince: null });

    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('keeps only the first reply of a spell', async () => {
    await log.replied('c1', 'agent-1');

    expect(repo.update).toHaveBeenCalledWith(
      {
        conversationId: 'c1',
        adminId: 'agent-1',
        endedAt: IsNull(),
        firstReplyAt: IsNull(),
      },
      { firstReplyAt: expect.any(Date) as Date },
    );
  });

  it('closes whatever spell is open, with why and who', async () => {
    await log.ended('c1', HandlingEndReason.RELEASED_BY_ADMIN, 'admin-9');

    expect(repo.update).toHaveBeenCalledWith(
      { conversationId: 'c1', endedAt: IsNull() },
      {
        endedAt: expect.any(Date) as Date,
        endReason: 'RELEASED_BY_ADMIN',
        endedByAdminId: 'admin-9',
      },
    );
  });

  it('never lets a failed write stop the chat being taken or answered', async () => {
    repo.insert.mockRejectedValue(new Error('db down'));
    repo.update.mockRejectedValue(new Error('db down'));

    await expect(
      log.started('c1', 'agent-1', { waitingSince: null }),
    ).resolves.toBeUndefined();
    await expect(log.replied('c1', 'agent-1')).resolves.toBeUndefined();
    await expect(
      log.ended('c1', HandlingEndReason.RELEASED),
    ).resolves.toBeUndefined();
  });

  it('turns the figures into numbers, and counts chats open now for everyone', async () => {
    rawResults = [
      [
        {
          adminId: 'agent-1',
          handled: '12',
          avgPickupSeconds: '95.4',
          avgFirstReplySeconds: '41.6',
          wentIdle: '1',
        },
      ],
      [
        { adminId: 'agent-1', openNow: '2' },
        // Holding a chat taken before the period: still shown.
        { adminId: 'agent-2', openNow: '1' },
      ],
    ];

    const stats = await log.stats(new Date(0), new Date());

    expect(stats).toEqual([
      {
        adminId: 'agent-1',
        handled: 12,
        openNow: 2,
        avgPickupSeconds: 95,
        avgFirstReplySeconds: 42,
        wentIdle: 1,
      },
      {
        adminId: 'agent-2',
        handled: 0,
        openNow: 1,
        avgPickupSeconds: null,
        avgFirstReplySeconds: null,
        wentIdle: 0,
      },
    ]);
  });
});
