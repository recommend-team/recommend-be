import { NestFactory } from '@nestjs/core';
import { VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { RedisIoAdapter } from './chat/transport/redis-io.adapter';

async function bootstrap() {
  // Enable rawBody so the Paystack webhook controller can verify HMAC signatures
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const configService = app.get(ConfigService);

  // Security middleware
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  app.use(helmet());
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  app.use(compression());

  // CORS
  const isProduction =
    configService.get<string>('app.nodeEnv') === 'production';
  const frontendUrl = configService.get<string>('app.frontendUrl');
  const allowedOrigins = isProduction
    ? [frontendUrl!]
    : ['http://localhost:3000', 'https://recommend-fe.netlify.app'];
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  // Socket.IO across processes. Attempted before listen() so a Redis problem shows up
  // at boot rather than as messages quietly failing to reach half the buyers.
  const redisAdapter = new RedisIoAdapter(app);
  const clustered = await redisAdapter.connect({
    url: configService.get<string>('redis.url'),
    host: configService.get<string>('redis.host') ?? 'localhost',
    port: configService.get<number>('redis.port') ?? 6379,
    password: configService.get<string>('redis.password'),
  });
  if (clustered) {
    app.useWebSocketAdapter(redisAdapter);
  }

  // API versioning
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // Global prefix
  app.setGlobalPrefix(configService.get<string>('app.apiPrefix')!);

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('Recommend API')
    .setDescription('WhatsApp-first local discovery and ordering platform')
    .setVersion('1.0')
    .addBearerAuth()
    .addSecurityRequirements('default')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  // Start server
  const port = configService.get<number>('app.port')!;
  await app.listen(port, '0.0.0.0');
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Swagger docs: http://localhost:${port}/api/docs`);
}

bootstrap().catch(console.error);
