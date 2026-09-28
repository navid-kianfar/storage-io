import { Module } from '@nestjs/common';
import { IamCoreModule } from '../iam-core/iam-core.module';
import { IamPoliciesController } from './iam-policies.controller';
import { IamPoliciesService } from './iam-policies.service';

@Module({
  imports: [IamCoreModule],
  controllers: [IamPoliciesController],
  providers: [IamPoliciesService],
  // Exported for `GET /search`, which searches policies alongside servers,
  // buckets, users, keys and jobs.
  exports: [IamPoliciesService],
})
export class IamPoliciesModule {}
