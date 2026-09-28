import { Module } from '@nestjs/common';
import { IamCoreModule } from '../iam-core/iam-core.module';
import { IamGroupsController } from './iam-groups.controller';
import { IamGroupsService } from './iam-groups.service';

/** The service is exported for `GET /search`, which lists groups alongside users. */
@Module({
  imports: [IamCoreModule],
  controllers: [IamGroupsController],
  providers: [IamGroupsService],
  exports: [IamGroupsService],
})
export class IamGroupsModule {}
