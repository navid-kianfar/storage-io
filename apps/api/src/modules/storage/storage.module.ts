import { Module } from '@nestjs/common';
import { ProvidersModule } from '../../providers/providers.module';
import { ServersModule } from '../../servers/servers.module';
import { StorageContextService } from './storage-context.service';

/**
 * The shared entry point into a storage server. It has no controllers and no
 * state: the buckets, objects, quotas and inventory modules import it so that
 * "resolve `:sid`, decrypt, get a client" is written once.
 */
@Module({
  imports: [ProvidersModule, ServersModule],
  providers: [StorageContextService],
  exports: [StorageContextService],
})
export class StorageModule {}
