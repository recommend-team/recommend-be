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
import { HandoverService } from './engine/handover.service';
import { AdminOrderService } from './engine/admin-order.service';
import { AdminCatalogService } from './engine/admin-catalog.service';
import { AdminChatController } from './transport/admin/admin-chat.controller';
import { AdminChatGateway } from './transport/admin/admin-chat.gateway';
import { PaymentConfirmationListener } from './engine/payment-confirmation.listener';
import { OrderStatusListener } from './engine/order-status.listener';
import { AppreciationService } from './engine/appreciation.service';
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
import { Checkout } from '../modules/orders/entities/checkout.entity';
import { Area } from '../modules/locations/entities/area.entity';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { BuyerPushSubscription } from './conversation/entities/buyer-push-subscription.entity';
import { BuyerPushService } from './engine/buyer-push.service';
import { LocalPushAdapter } from './adapters/local-push.adapter';
import { PUSH_PORT } from './ports/push.port';
import { ChatAccount } from './account/entities/chat-account.entity';
import { AccountService } from './account/account.service';
import { LoginCodeService } from './account/login-code.service';
import { EMAIL_PORT } from './ports/email.port';
import { LocalEmailAdapter } from './adapters/local-email.adapter';
import { EmailService } from '../common/services/email.service';

/**
 * The chat bounded context. `AppModule` importing this is the only permitted crossing
 * of the boundary — see `src/chat/README.md`.
 *
 * Secrets are passed per-call in SessionService, so JwtModule needs no static config.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Conversation,
      ChatMessage,
      BuyerPushSubscription,
      ChatAccount,
      User,
      Product,
      Area,
      Checkout,
    ]),
    JwtModule.register({}),
    OrdersModule,
    NotificationsModule,
  ],
  controllers: [AdminChatController],
  providers: [
    ConversationService,
    SessionService,
    ChatRateLimitService,
    EngineService,
    HandoverService,
    AdminOrderService,
    AdminCatalogService,
    CheckoutFlow,
    PaymentConfirmationListener,
    OrderStatusListener,
    AppreciationService,
    ChannelRegistry,
    PwaChannel,
    PwaGateway,
    AdminChatGateway,
    DiscoveryService,
    { provide: CATALOG_PORT, useClass: LocalCatalogAdapter },
    { provide: LOCATION_PORT, useClass: LocalLocationAdapter },
    { provide: ORDERING_PORT, useClass: LocalOrderingAdapter },
    { provide: IDENTITY_PORT, useClass: LocalIdentityAdapter },
    { provide: PUSH_PORT, useClass: LocalPushAdapter },
    BuyerPushService,
    AccountService,
    LoginCodeService,
    EmailService,
    { provide: EMAIL_PORT, useClass: LocalEmailAdapter },
  ],
  exports: [ConversationService, SessionService],
})
export class ChatModule {}
