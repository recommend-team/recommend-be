import { Controller, Get, Inject, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../../../modules/auth/decorators/roles.decorator';
import { Role } from '../../../common/enums/roles.enum';
import {
  AgentStats,
  HandlingLogService,
} from '../../engine/handling-log.service';
import { IDENTITY_PORT } from '../../ports/identity.port';
import type { IdentityPort } from '../../ports/identity.port';

/** How far back the figures can look. */
const MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The people answering buyers, and how it is going — for admins. Also what the "pass to a
 * colleague" picker lists, with how many chats each already has.
 */
@ApiTags('Admin — customer service team')
@ApiBearerAuth()
@Controller('admin/support-team')
@Roles(Role.ADMIN)
export class SupportTeamController {
  constructor(
    private readonly handlingLog: HandlingLogService,
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Everyone who answers chats, with their figures',
    description:
      'Every active admin and agent, plus anyone who handled chats in the period and has ' +
      'since left. `openNow` is chats they have right now; the rest covers chats taken ' +
      'in the last `days` days. Times are in seconds, null when there is nothing to ' +
      'average. `avgPickupSeconds` is how long buyers had been waiting when they took ' +
      'them — chats passed to them by an admin are left out of it.',
  })
  @ApiQuery({ name: 'days', required: false, example: 7 })
  @ApiResponse({ status: 200, description: 'The team' })
  async team(@Query('days') days?: string) {
    const span = Math.min(
      MAX_DAYS,
      Math.max(1, Number.parseInt(days ?? '', 10) || 7),
    );
    const to = new Date();
    const from = new Date(to.getTime() - span * DAY_MS);

    const [staff, stats] = await Promise.all([
      this.identity.listStaff(),
      this.handlingLog.stats(from, to),
    ]);
    const byAdmin = new Map(stats.map((row) => [row.adminId, row]));

    // Someone who answered chats and has since been suspended still did the work.
    const gone = stats
      .map((row) => row.adminId)
      .filter((id) => !staff.some((member) => member.id === id));
    const goneNames = await this.identity
      .staffNames(gone)
      .catch(() => new Map<string, string>());

    const agents = [
      ...staff.map((member) => ({
        ...figures(member.id, byAdmin.get(member.id)),
        name: member.name,
        role: member.role,
        active: true,
      })),
      ...gone.map((id) => ({
        ...figures(id, byAdmin.get(id)),
        name: goneNames.get(id) ?? 'Former staff',
        role: null,
        active: false,
      })),
    ].sort((a, b) => b.openNow - a.openNow || b.handled - a.handled);

    return {
      message: 'Team retrieved successfully',
      data: { days: span, from, to, agents },
    };
  }
}

function figures(adminId: string, stats: AgentStats | undefined) {
  return {
    adminId,
    handled: stats?.handled ?? 0,
    openNow: stats?.openNow ?? 0,
    avgPickupSeconds: stats?.avgPickupSeconds ?? null,
    avgFirstReplySeconds: stats?.avgFirstReplySeconds ?? null,
    wentIdle: stats?.wentIdle ?? 0,
  };
}
