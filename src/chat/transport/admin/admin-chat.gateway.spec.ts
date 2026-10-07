import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Server, Socket } from 'socket.io';
import { AdminChatGateway } from './admin-chat.gateway';
import { Role } from '../../../common/enums/roles.enum';
import { AdminAlertEvent } from '../../../common/events/admin-alert.events';

const SECRET = 'test-secret';

describe('AdminChatGateway alerts', () => {
  let gateway: AdminChatGateway;
  let emit: jest.Mock;
  let to: jest.Mock;
  const jwt = new JwtService();

  beforeEach(() => {
    gateway = new AdminChatGateway(jwt, {
      get: () => SECRET,
    } as unknown as ConfigService);
    emit = jest.fn();
    to = jest.fn(() => ({ emit }));
    gateway.server = { to } as unknown as Server;
  });

  const alert = (adminId: string | null) =>
    new AdminAlertEvent(
      'alert-1',
      'CONVERSATION_FLAGGED',
      'A buyer needs help',
      'Ada — stuck.',
      '/admin/conversations/c1',
      adminId,
      new Date(),
    );

  it('broadcasts an alert for everyone to every admin', () => {
    gateway.onAdminAlert(alert(null));

    expect(to).toHaveBeenCalledWith('admins');
    expect(emit).toHaveBeenCalledWith(
      'admin:alert',
      expect.objectContaining({
        id: 'alert-1',
        url: '/admin/conversations/c1',
      }),
    );
  });

  it('sends an alert for one admin to that admin only', () => {
    gateway.onAdminAlert(alert('a2'));

    expect(to).toHaveBeenCalledWith('admin:a2');
  });

  it('puts a connecting admin in both rooms', () => {
    const joined: string[] = [];
    const socket = {
      handshake: {
        auth: {
          token: jwt.sign({ sub: 'a1', role: Role.ADMIN }, { secret: SECRET }),
        },
        headers: {},
      },
      data: {},
      join: (name: string) => joined.push(name),
      emit: jest.fn(),
      disconnect: jest.fn(),
    } as unknown as Socket;

    gateway.handleConnection(socket);

    expect(joined).toEqual(['admins', 'admin:a1']);
  });
});
