import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppConfigModule } from './config/config.module';
import { AppConfigService } from './config/app-config.service';
import { DbModule } from './db/db.module';
import { CryptoModule } from './crypto/crypto.module';
import { SettingsModule } from './settings/settings.module';
import { EventsModule } from './events/events.module';
import { ActivityModule } from './activity/activity.module';
import { ActivityInterceptor } from './activity/activity.interceptor';
import { NotificationsModule } from './notifications/notifications.module';
import { AuthModule } from './auth/auth.module';
import { ProvidersModule } from './providers/providers.module';
import { ServersModule } from './servers/servers.module';
import { StorageModule } from './modules/storage/storage.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { QuotasModule } from './modules/quotas/quotas.module';
import { ObjectsModule } from './modules/objects/objects.module';
import { BucketsModule } from './modules/buckets/buckets.module';
import { IamCoreModule } from './modules/iam-core/iam-core.module';
import { AccessKeysModule } from './modules/access-keys/access-keys.module';
import { IamUsersModule } from './modules/iam-users/iam-users.module';
import { IamGroupsModule } from './modules/iam-groups/iam-groups.module';
import { IamPoliciesModule } from './modules/iam-policies/iam-policies.module';
import { ServerCredentialsModule } from './modules/server-credentials/server-credentials.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { SearchModule } from './modules/search/search.module';
import { ConfigBackupModule } from './modules/config-backup/config-backup.module';
import { WebStaticModule } from './web/web-static.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { HealthController } from './health/health.controller';
import { ProblemExceptionFilter } from './common/filters/problem.filter';
import { AuthGuard } from './common/guards/auth.guard';
import { OriginGuard } from './common/guards/origin.guard';
import { AllowedNetworksMiddleware } from './common/middleware/allowed-networks.middleware';
import { DEFAULT_THROTTLER, LOGIN_THROTTLER, skipUnlessLoginRoute } from './auth/login-throttler';
import { buildLoggerOptions } from './logging';

/**
 * The application root.
 *
 * The global registrations are the security posture, and their order is load
 * bearing:
 *
 * 1. `AllowedNetworksMiddleware` — before anything else, including streaming
 *    routes that never reach a controller.
 * 2. `ThrottlerGuard` — rate limiting before the expensive work.
 * 3. `AuthGuard` — everything is protected unless marked `@Public()`.
 * 4. `OriginGuard` — after auth, because it needs to know *how* the request
 *    authenticated: only a cookie session is forgeable cross-site.
 * 5. `ZodValidationPipe` — one pipe, validating against the contract schemas.
 * 6. `ActivityInterceptor` — records every mutating request, success or failure.
 * 7. `ProblemExceptionFilter` — one error envelope for the whole API.
 *
 * Modules are split by domain. The infrastructure ones (config, db, crypto,
 * settings, events, activity, notifications) are `@Global()` because every
 * feature module needs them and threading imports through each new module is a
 * step someone will forget.
 */
@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => buildLoggerOptions(config),
    }),
    DbModule,
    CryptoModule,
    SettingsModule,
    EventsModule,
    ActivityModule,
    NotificationsModule,
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        throttlers: [
          // The whole API: generous, to stop a runaway client, not a user.
          { name: DEFAULT_THROTTLER, ttl: 60_000, limit: 600 },
          // Login: the brute-force limit, from the environment. `skipIf` is
          // what confines it to the login route — see login-throttler.ts.
          {
            name: LOGIN_THROTTLER,
            ttl: config.loginRateTtlSec * 1000,
            limit: config.loginRateLimit,
            skipIf: skipUnlessLoginRoute,
          },
        ],
      }),
    }),
    AuthModule,
    ProvidersModule,
    ServersModule,
    // Wave 2a, in dependency order: storage context, the inventory cache, the
    // jobs seam, then the three feature modules built on them.
    StorageModule,
    InventoryModule,
    JobsModule,
    QuotasModule,
    ObjectsModule,
    BucketsModule,
    // Wave 2b: the IAM modules. `IamCoreModule` carries what they share (server
    // resolution, key_meta, policy_versions, the expiry sweep, the count cache);
    // each of the four is otherwise independent.
    IamCoreModule,
    AccessKeysModule,
    IamUsersModule,
    IamGroupsModule,
    IamPoliciesModule,
    ServerCredentialsModule,
    // Wave 2c: the jobs engine lives behind the same JOBS_PORT wave 2a bound, and
    // these three aggregate what every module above them owns — so they come last
    // and own no table of their own.
    DashboardModule,
    SearchModule,
    ConfigBackupModule,
    MaintenanceModule,
    // Last of all: the SPA fallback matches every path no controller claimed, so
    // anything registered after it would never be reached.
    WebStaticModule.forRoot(),
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ActivityInterceptor },
    { provide: APP_FILTER, useClass: ProblemExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AllowedNetworksMiddleware).forRoutes('*path');
  }
}
