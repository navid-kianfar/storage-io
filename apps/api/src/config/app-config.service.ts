import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from './env.schema';

/** DI token for the parsed environment. */
export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * A thin, typed wrapper so a consumer injects `AppConfigService` rather than
 * reaching for `ConfigService.get('SOME_KEY')` and losing the type.
 */
@Injectable()
export class AppConfigService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get values(): AppConfig {
    return this.config;
  }

  get port(): number {
    return this.config.PORT;
  }

  get host(): string {
    return this.config.HOST;
  }

  get isProduction(): boolean {
    return this.config.isProduction;
  }

  get isTest(): boolean {
    return this.config.isTest;
  }

  get databasePath(): string {
    return this.config.DATABASE_PATH;
  }

  get appSecret(): string {
    return this.config.APP_SECRET;
  }

  get adminUsername(): string {
    return this.config.ADMIN_USERNAME;
  }

  get adminPassword(): string | undefined {
    return this.config.ADMIN_PASSWORD;
  }

  get adminPasswordHash(): string | undefined {
    return this.config.ADMIN_PASSWORD_HASH;
  }

  get cookieSecure(): boolean {
    return this.config.COOKIE_SECURE;
  }

  get allowedOrigins(): readonly string[] {
    return this.config.allowedOrigins;
  }

  get swaggerEnabled(): boolean {
    return this.config.swaggerEnabled;
  }

  get healthCheckerEnabled(): boolean {
    return this.config.HEALTH_CHECKER_ENABLED;
  }

  get inventoryRefresherEnabled(): boolean {
    return this.config.INVENTORY_REFRESHER_ENABLED;
  }

  get iamSchedulerEnabled(): boolean {
    return this.config.IAM_SCHEDULER_ENABLED;
  }

  get jobEngineEnabled(): boolean {
    return this.config.JOB_ENGINE_ENABLED;
  }

  /** `null` when the API is not serving the built web app. */
  get webDist(): string | null {
    return this.config.WEB_DIST ?? null;
  }

  get loginRateLimit(): number {
    return this.config.LOGIN_RATE_LIMIT;
  }

  get loginRateTtlSec(): number {
    return this.config.LOGIN_RATE_TTL_SEC;
  }
}
