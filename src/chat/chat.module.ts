import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { Conversation } from './conversation/entities/conversation.entity';
import { ChatMessage } from './conversation/entities/message.entity';
import { User } from '../modules/auth/entities/auth.entity';
import { Product } from '../modules/products/entities/product.entity';
import { ConversationService } from './conversation/conversation.service';
import { SessionService } from './session/session.service';
import { EngineService } from './engine/engine.service';
import { ChannelRegistry } from './transport/channel.registry';
import { PwaChannel } from './transport/pwa/pwa.channel';
import { PwaGateway } from './transport/pwa/pwa.gateway';
import { LocalCatalogAdapter } from './adapters/local-catalog.adapter';
import { LocalLocationAdapter } from './adapters/local-location.adapter';
import { CATALOG_PORT } from './ports/catalog.port';
import { LOCATION_PORT } from './ports/location.port';
import { DiscoveryService } from './engine/discovery/discovery.service';
import { Area } from '../modules/locations/entities/area.entity';

/**
 * The chat bounded context. `AppModule` importing this is the only permitted crossing
 * of the boundary — see `src/chat/README.md`.
 *
 * Secrets are passed per-call in SessionService, so JwtModule needs no static config.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, ChatMessage, User, Product, Area]),
    JwtModule.register({}),
  ],
  providers: [
    ConversationService,
    SessionService,
    EngineService,
    ChannelRegistry,
    PwaChannel,
    PwaGateway,
    DiscoveryService,
    { provide: CATALOG_PORT, useClass: LocalCatalogAdapter },
    { provide: LOCATION_PORT, useClass: LocalLocationAdapter },
  ],
  exports: [ConversationService, SessionService],
})
export class ChatModule {}
