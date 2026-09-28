import { Module } from '@nestjs/common';
import { ServersModule } from '../../servers/servers.module';
import { InventoryModule } from '../inventory/inventory.module';
import { JobsModule } from '../jobs/jobs.module';
import { IamUsersModule } from '../iam-users/iam-users.module';
import { AccessKeysModule } from '../access-keys/access-keys.module';
import { IamPoliciesModule } from '../iam-policies/iam-policies.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/**
 * `GET /search`. Like the dashboard it owns no table and aggregates other
 * modules', so it is imported after all of them.
 */
@Module({
  imports: [
    ServersModule,
    InventoryModule,
    JobsModule,
    IamUsersModule,
    AccessKeysModule,
    IamPoliciesModule,
  ],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
