import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Server, Socket } from 'socket.io';
import { AdminChatGateway } from './admin-chat.gateway';
import {
  ChatMessageRecordedEvent,
  ConversationHolderChangedEvent,
} from './admin-chat.events';
import { Role } from '../../../common/enums/roles.enum';
import {
  AdminAlertEvent,
  type AdminAlertKind,
} from '../../../common/events/admin-alert.events';
import type { IdentityPort, StaffMember } from '../../ports/identity.port';

const SECRET = 'test-secret';

describe('AdminChatGateway', () => {
  let gateway: AdminChatGateway;
  let emit: jest.Mock;
  let to: jest.Mock;
  let staff: Map<string, StaffMember>;
  const jwt = new JwtService();

  beforeEach(() => {
    staff = new Map([
      ['a1', { id: 'a1', role: Role.ADMIN, name: 'Ada O.' }],
      ['s1', { id: 's1', role: Role.SUPPORT, name: 'Amaka N.' }],
    ]);
    const identity: IdentityPort = {
      staffMember: (id) => Promise.resolve(staff.get(id) ?? null),
      staffNames: (ids) =>
        Promise.resolve(
          new Map(
            ids
              .filter((id) => staff.has(id))
              .map((id) => [id, staff.get(id)!.name]),
          ),
        ),
      listStaff: () => Promise.resolve([...staff.values()]),
      upsertBuyer: jest.fn(),
    };
    gateway = new AdminChatGateway(
      jwt,
      { get: () => SECRET } as unknown as ConfigService,
      identity,
    );
    emit = jest.fn();
    to = jest.fn(() => ({ emit }));
    gateway.server = { to } as unknown as Server;
  });

  const alert = (adminId: string | null, kind: AdminAlertKind) =>
    new AdminAlertEvent(
      'alert-1',
      kind,
      'A buyer needs help',
      'Ada — stuck.',
      '/admin/conversations/c1',
      adminId,
      new Date(),
    );

  const connect = (sub: string, role: Role) => {
    const joined: string[] = [];
    const socket = {
      handshake: {
        auth: { token: jwt.sign({ sub, role }, { secret: SECRET }) },
        headers: {},
      },
      data: {},
      join: (name: string) => joined.push(name),
      leave: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    } as unknown as Socket & { emit: jest.Mock; disconnect: jest.Mock };
    return { socket, joined };
  };

  describe('alerts', () => {
    it('sends a waiting buyer to all staff, customer service included', () => {
      gateway.onAdminAlert(alert(null, 'CONVERSATION_FLAGGED'));

      expect(to).toHaveBeenCalledWith('staff');
      expect(emit).toHaveBeenCalledWith(
        'admin:alert',
        expect.objectContaining({
          id: 'alert-1',
          url: '/admin/conversations/c1',
        }),
      );
    });

    it('keeps order, payout and delivery alerts to admins', () => {
      gateway.onAdminAlert(alert(null, 'WITHDRAWAL_FAILED'));

      expect(to).toHaveBeenCalledWith('admins');
    });

    it('sends an alert for one person to that person only', () => {
      gateway.onAdminAlert(alert('a2', 'HELD_CONVERSATION_MESSAGE'));

      expect(to).toHaveBeenCalledWith('admin:a2');
    });
  });

  describe('connecting', () => {
    it('puts an admin in the staff, admin and personal rooms', async () => {
      const { socket, joined } = connect('a1', Role.ADMIN);

      await gateway.handleConnection(socket);

      expect(joined).toEqual(['staff', 'admins', 'admin:a1']);
    });

    it('keeps customer service out of the admin room', async () => {
      const { socket, joined } = connect('s1', Role.SUPPORT);

      await gateway.handleConnection(socket);

      expect(joined).toEqual(['staff', 'admin:s1']);
    });

    it('goes by the account, not a days-old token', async () => {
      // Signed when they were an admin; demoted to customer service since.
      staff.set('a1', { id: 'a1', role: Role.SUPPORT, name: 'Ada O.' });
      const { socket, joined } = connect('a1', Role.ADMIN);

      await gateway.handleConnection(socket);

      expect(joined).not.toContain('admins');
    });

    it('turns away anyone who is not active staff', async () => {
      const { socket, joined } = connect('suspended-or-vendor', Role.ADMIN);

      await gateway.handleConnection(socket);

      expect(joined).toEqual([]);
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('lets a watch sent while connecting wait for the check, not vanish', async () => {
      const { socket, joined } = connect('s1', Role.SUPPORT);

      const connecting = gateway.handleConnection(socket);
      const watching = gateway.watch(socket, { conversationId: 'c1' });
      await Promise.all([connecting, watching]);

      expect(joined).toContain('conversation:c1');
    });
  });

  describe('messages', () => {
    it('names the colleague who typed a reply, for anyone else watching', async () => {
      await gateway.onMessageRecorded(
        new ChatMessageRecordedEvent({
          id: 'm1',
          conversationId: 'c1',
          direction: 'OUTBOUND',
          author: 'ASSISTANT',
          adminId: 's1',
          text: 'I can help with that.',
          payload: null,
          createdAt: new Date(),
        } as never),
      );

      expect(to).toHaveBeenCalledWith('conversation:c1');
      expect(emit).toHaveBeenCalledWith(
        'admin:message',
        expect.objectContaining({ adminId: 's1', adminName: 'Amaka N.' }),
      );
    });
  });

  describe('who holds a chat', () => {
    it('tells every agent, by name, when a colleague takes one', async () => {
      await gateway.onHolderChanged(
        new ConversationHolderChangedEvent('c1', 's1'),
      );

      expect(to).toHaveBeenCalledWith('staff');
      expect(emit).toHaveBeenCalledWith('admin:conversation', {
        conversationId: 'c1',
        heldByAdminId: 's1',
        heldByName: 'Amaka N.',
      });
    });

    it('tells them when it is free again', async () => {
      await gateway.onHolderChanged(
        new ConversationHolderChangedEvent('c1', null),
      );

      expect(emit).toHaveBeenCalledWith('admin:conversation', {
        conversationId: 'c1',
        heldByAdminId: null,
        heldByName: null,
      });
    });
  });
});
