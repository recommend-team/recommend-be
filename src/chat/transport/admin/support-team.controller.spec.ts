import { SupportTeamController } from './support-team.controller';
import { Role } from '../../../common/enums/roles.enum';
import type { IdentityPort } from '../../ports/identity.port';
import type { HandlingLogService } from '../../engine/handling-log.service';

describe('SupportTeamController', () => {
  const identity: IdentityPort = {
    staffMember: jest.fn(),
    staffNames: jest.fn((ids: string[]) =>
      Promise.resolve(
        new Map(
          ids.filter((id) => id === 'gone-1').map((id) => [id, 'Tolu A.']),
        ),
      ),
    ),
    listStaff: jest.fn(() =>
      Promise.resolve([
        { id: 'agent-1', role: Role.SUPPORT, name: 'Amaka N.' },
        { id: 'agent-2', role: Role.SUPPORT, name: 'Bayo K.' },
        { id: 'admin-1', role: Role.ADMIN, name: 'Ada O.' },
      ]),
    ),
    upsertBuyer: jest.fn(),
  };
  const stats = jest.fn();
  const controller = new SupportTeamController(
    { stats } as unknown as HandlingLogService,
    identity,
  );

  beforeEach(() => stats.mockReset());

  const row = (adminId: string, handled: number, openNow: number) => ({
    adminId,
    handled,
    openNow,
    avgPickupSeconds: 60,
    avgFirstReplySeconds: 30,
    wentIdle: 0,
  });

  it('lists everyone who can answer, busiest first, with zeros for the quiet ones', async () => {
    stats.mockResolvedValue([row('agent-2', 9, 3), row('agent-1', 4, 0)]);

    const { data } = await controller.team('7');

    expect(
      data.agents.map((agent) => [agent.name, agent.openNow, agent.handled]),
    ).toEqual([
      ['Bayo K.', 3, 9],
      ['Amaka N.', 0, 4],
      ['Ada O.', 0, 0],
    ]);
    expect(data.agents[2]).toMatchObject({
      avgPickupSeconds: null,
      avgFirstReplySeconds: null,
      active: true,
    });
  });

  it('keeps the work of someone who has since left', async () => {
    stats.mockResolvedValue([row('gone-1', 5, 0)]);

    const { data } = await controller.team('30');

    expect(data.agents).toContainEqual(
      expect.objectContaining({
        adminId: 'gone-1',
        name: 'Tolu A.',
        active: false,
      }),
    );
  });

  it('looks back 7 days unless asked, and never more than 90', async () => {
    stats.mockResolvedValue([]);

    expect((await controller.team(undefined)).data.days).toBe(7);
    expect((await controller.team('365')).data.days).toBe(90);
    expect((await controller.team('nonsense')).data.days).toBe(7);
  });
});
