import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { APP_CONFIG, AppConfigService } from './app-config.service';
import { validateEnv, type AppConfig } from './env.schema';

/**
 * Global on purpose: every module needs the config and threading an import
 * through each of them buys nothing.
 *
 * `@nestjs/config` only loads the `.env` file; the zod schema is the authority
 * on what is valid, and `validateEnv` throws before Nest finishes bootstrapping.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // `.env.test` first so a test run never reads the developer's own .env.
      envFilePath: process.env['NODE_ENV'] === 'test' ? ['.env.test', '.env'] : ['.env'],
    }),
  ],
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => validateEnv(process.env),
    },
    AppConfigService,
  ],
  exports: [APP_CONFIG, AppConfigService],
})
export class AppConfigModule {}
