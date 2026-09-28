import { Module } from '@nestjs/common';
import { ProvidersModule } from '../../providers/providers.module';
import { ServersModule } from '../../servers/servers.module';
import { IamTargetService } from './iam-target.service';
import { IamStatsService } from './iam-stats.service';
import { KeyExpiryService } from './key-expiry.service';
import { IamEntityRepository } from './iam-entity.repository';
import { KeyMetaRepository } from './key-meta.repository';
import { PolicyVersionRepository } from './policy-version.repository';

/**
 * What the four IAM modules share: resolving a request to the server(s) it acts
 * on, the two app-owned tables (`key_meta`, `policy_versions`), the expiry sweep
 * and the cached counts.
 *
 * It has no controllers. Everything in it is a singleton — the sweep and the count
 * cache are process-wide by nature, and a request-scoped provider would rebuild the
 * cache per request.
 *
 * `IamStatsService` is exported for wave 2c's dashboard (`totals.users`,
 * `totals.accessKeys`) as well as for the modules here. `IamEntityRepository` —
 * the opaque id of a user, group, policy or key — is exported for the same
 * reason: every IAM list stamps one, and the resolve endpoints read them back.
 */
@Module({
  imports: [ProvidersModule, ServersModule],
  providers: [
    IamTargetService,
    IamEntityRepository,
    KeyMetaRepository,
    PolicyVersionRepository,
    KeyExpiryService,
    IamStatsService,
  ],
  exports: [
    IamTargetService,
    IamEntityRepository,
    KeyMetaRepository,
    PolicyVersionRepository,
    KeyExpiryService,
    IamStatsService,
  ],
})
export class IamCoreModule {}
