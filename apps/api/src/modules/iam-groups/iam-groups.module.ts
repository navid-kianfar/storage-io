import { Module } from '@nestjs/common';
import { IamCoreModule } from '../iam-core/iam-core.module';
import { IamGroupsController } from './iam-groups.controller';
import { IamGroupsService } from './iam-groups.service';

@Module({
  imports: [IamCoreModule],
  controllers: [IamGroupsController],
  providers: [IamGroupsService],
})
export class IamGroupsModule {}
