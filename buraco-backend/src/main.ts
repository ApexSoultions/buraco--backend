import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const compression = require('compression');
import helmet from 'helmet';
import { AppModule } from './app.module';
import { checkSecretsOrThrow } from './config/env-check';

async function bootstrap() {
  // Before anything else: in production, weak or missing token secrets stop the start.
  const secretWarnings = checkSecretsOrThrow();
  if (secretWarnings.length) {
    console.warn('[env] Not safe for production:\n  - ' + secretWarnings.join('\n  - '));
  }

  const app = await NestFactory.create(AppModule);

  // Rate limits key signed-out traffic on req.ip. Trust X-Forwarded-For only from a proxy
  // on this machine (e.g. nginx for HTTPS later); without it, every request would appear to
  // come from 127.0.0.1 and share one limit. Direct clients cannot spoof the header.
  app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');

  // Security — CSP disabled so Swagger UI inline scripts load correctly
  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );
  app.use(compression());
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
    : '*';
  app.enableCors({ origin: allowedOrigins, credentials: true });

  // Global prefix
  app.setGlobalPrefix('v1');

  // Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Swagger
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Barasilian Cards Game API')
    .setDescription('Server-authoritative multiplayer backend for Barasilian Cards Game')
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('Auth')
    .addTag('Profile')
    .addTag('Stats')
    .addTag('Economy')
    .addTag('Missions')
    .addTag('Friends')
    .addTag('Clubs')
    .addTag('Rankings')
    .addTag('Shop')
    .addTag('Notifications')
    .addTag('Matchmaking')
    .addTag('Rooms')
    .addTag('Game')
    .addTag('Messaging')
    .addTag('Match History')
    .addTag('Admin')
    .build();

  // Public API map at `/`: useful while the client is being built, off for the release
  // (SWAGGER_ENABLED=false).
  const swaggerEnabled = app.get(ConfigService).get<boolean>('swagger.enabled') !== false;
  if (swaggerEnabled) {
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('/', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Barasilian Cards Game API running on port ${port}`);
  console.log(swaggerEnabled ? `Swagger docs at http://localhost:${port}/` : 'Swagger docs disabled (SWAGGER_ENABLED=false)');
}
bootstrap();
