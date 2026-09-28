import { Module } from '@nestjs/common';
import { ProvidersModule } from '../../providers/providers.module';
import { ServersModule } from '../../servers/servers.module';
import { IamCoreModule } from '../iam-core/iam-core.module';
import { ServerCredentialsController } from './server-credentials.controller';
import { ServerCredentialsService } from './server-credentials.service';

/**
 * Credential rotation for a storage server. It is its own module because it sits
 * between the servers module (the row and its secret) and the IAM drivers (the key
 * to create), and putting it in either would make that pair circular.
 */
@Module({
  imports: [IamCoreModule, ServersModule, ProvidersModule],
  controllers: [ServerCredentialsController],
  providers: [ServerCredentialsService],
})
export class ServerCredentialsModule {}
