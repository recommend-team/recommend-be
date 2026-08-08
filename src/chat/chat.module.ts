import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { Conversation } from './conversation/entities/conversation.entity';
import { ChatMessage } from './conversation/entities/message.entity';
import { User } from '../modules/auth/entities/auth.entity';
import { Product } from '../modules/products/entities/product.entity';
import { ConversationService } from './conversation/conversation.service';
import { SessionService } from './session/session.service';
import { ChatRateLimitService } from './session/rate-limit.service';
import { EngineService } from './engine/engine.service';
import { PaymentConfirmationListener } from './engine/payment-confirmation.listener';
import { ChannelRegistry } from './transport/channel.registry';
import { PwaChannel } from './transport/pwa/pwa.channel';
import { PwaGateway } from './transport/pwa/pwa.gateway';
import { LocalCatalogAdapter } from './adapters/local-catalog.adapter';
import { LocalLocationAdapter } from './adapters/local-location.adapter';
import { CATALOG_PORT } from './ports/catalog.port';
import { LOCATION_PORT } from './ports/location.port';
import { DiscoveryService } from './engine/discovery/discovery.service';
import { CheckoutFlow } from './engine/flows/checkout.flow';
import { LocalOrderingAdapter } from './adapters/local-ordering.adapter';
import { LocalIdentityAdapter } from './adapters/local-identity.adapter';
import { ORDERING_PORT } from './ports/ordering.port';
import { IDENTITY_PORT } from './ports/identity.port';
import { OrdersModule } from '../modules/orders/orders.module';
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
    OrdersModule,
  ],
  providers: [
    ConversationService,
    SessionService,
    ChatRateLimitService,
    EngineService,
    CheckoutFlow,
    PaymentConfirmationListener,
    ChannelRegistry,
    PwaChannel,
    PwaGateway,
    DiscoveryService,
    { provide: CATALOG_PORT, useClass: LocalCatalogAdapter },
    { provide: LOCATION_PORT, useClass: LocalLocationAdapter },
    { provide: ORDERING_PORT, useClass: LocalOrderingAdapter },
    { provide: IDENTITY_PORT, useClass: LocalIdentityAdapter },
  ],
  exports: [ConversationService, SessionService],
})
export class ChatModule {}
