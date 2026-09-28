import { Module } from '@nestjs/common';
import { ProvidersModule } from '../../providers/providers.module';
import { ServersModule } from '../../servers/servers.module';
import { ConfigBackupController } from './config-backup.controller';
import { ConfigBackupService } from './config-backup.service';

/**
 * `POST /settings/export` and `POST /settings/import`. It lives outside
 * `SettingsModule` because it needs the server repository and the provider
 * registry, which settings has no business knowing about — see the controller.
 */
@Module({
  imports: [ServersModule, ProvidersModule],
  controllers: [ConfigBackupController],
  providers: [ConfigBackupService],
  exports: [ConfigBackupService],
})
export class ConfigBackupModule {}
