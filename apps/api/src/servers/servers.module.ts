import { Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { HealthCheckerService } from './health-checker.service';
import { ServerRepository } from './server.repository';
import { ServersController } from './servers.controller';
import { ServersService } from './servers.service';

/**
 * `ServerRepository` is exported because the buckets, objects and IAM modules a
 * later task adds all need a `ServerConnection` — and building one means
 * decrypting a secret, which must stay in one place.
 */
@Module({
  imports: [ProvidersModule],
  controllers: [ServersController],
  providers: [ServersService, ServerRepository, HealthCheckerService],
  exports: [ServersService, ServerRepository, HealthCheckerService],
})
export class ServersModule {}
