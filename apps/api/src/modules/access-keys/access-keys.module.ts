import { Module } from '@nestjs/common';
import { IamCoreModule } from '../iam-core/iam-core.module';
import { AccessKeysController } from './access-keys.controller';
import { AccessKeysService } from './access-keys.service';

/**
 * `AccessKeysService` is exported because the user detail endpoint lists a user's
 * keys and the user delete removes them: the merge rules and the `key_meta`
 * bookkeeping belong in one place, not copied into the users module.
 */
@Module({
  imports: [IamCoreModule],
  controllers: [AccessKeysController],
  providers: [AccessKeysService],
  exports: [AccessKeysService],
})
export class AccessKeysModule {}
