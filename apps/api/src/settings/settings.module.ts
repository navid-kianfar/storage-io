import { Global, Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/**
 * Global: the auth guard's session TTL, the allowed-networks middleware, the
 * health checker's thresholds and the notification router all read settings, and
 * the cache inside the service only helps if there is one instance.
 */
@Global()
@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
