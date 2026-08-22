import { IoAdapter } from '@nestjs/platform-socket.io';
import { INestApplicationContext, Logger } from '@nestjs/common';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';

/**
 * Makes Socket.IO work across more than one process.
 */
/** Host and port only — a URL carries credentials that must never reach a log. */
function describe(options: {
  url?: string;
  host: string;
  port: number;
}): string {
  if (!options.url) return `${options.host}:${options.port}`;
  try {
    const parsed = new URL(options.url);
    return `${parsed.hostname}:${parsed.port || 6379} (${parsed.protocol.replace(':', '')})`;
  } catch {
    return 'configured URL';
  }
}

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  /**
   * Returns true when the adapter is live. Called before `listen()` so failure is
   * visible at boot rather than the first time a message goes missing.
   */
  async connect(options: {
    url?: string;
    host: string;
    port: number;
    password?: string;
  }): Promise<boolean> {
    const shared = {
      // Fail fast at startup instead of hanging the boot on an unreachable host.
      // Managed Redis lives across the internet, so allow more than a LAN would need.
      connectTimeout: 10000,
      maxRetriesPerRequest: 1,
      retryStrategy: (times: number) =>
        times > 3 ? null : Math.min(times * 200, 1000),
      lazyConnect: true,
    };

    // A URL carries its own scheme, credentials and TLS settings — ioredis enables
    // TLS from `rediss://` on its own, so it must not be rebuilt from parts.
    const pubClient = options.url
      ? new Redis(options.url, shared)
      : new Redis({
          host: options.host,
          port: options.port,
          password: options.password,
          ...shared,
        });
    const subClient = pubClient.duplicate();

    // Without handlers, a later connection drop becomes an unhandled error event and
    // takes the process down.
    for (const client of [pubClient, subClient]) {
      client.on('error', (error: Error) => {
        this.logger.warn(`Socket.IO Redis client error: ${error.message}`);
      });
    }

    try {
      await Promise.all([pubClient.connect(), subClient.connect()]);
      this.adapterConstructor = createAdapter(pubClient, subClient);
      this.logger.log(`Socket.IO clustered via Redis at ${describe(options)}`);
      return true;
    } catch (error) {
      this.logger.warn(
        `Redis unavailable (${
          error instanceof Error ? error.message : 'unknown error'
        }) — Socket.IO is running single-instance. Messages will NOT reach clients ` +
          'connected to another process.',
      );
      pubClient.disconnect();
      subClient.disconnect();
      return false;
    }
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options) as {
      adapter?: (constructor: unknown) => void;
      of: (namespace: string) => { adapter: (constructor: unknown) => void };
    };

    if (this.adapterConstructor) {
      // Applies to every namespace, including /chat.
      server.adapter?.(this.adapterConstructor);
    }

    return server;
  }
}
