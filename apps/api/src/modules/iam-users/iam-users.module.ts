import { Module } from '@nestjs/common';
import { IamCoreModule } from '../iam-core/iam-core.module';
import { AccessKeysModule } from '../access-keys/access-keys.module';
import { IamUsersController } from './iam-users.controller';
import { IamUsersService } from './iam-users.service';

/**
 * `AccessKeysModule` is imported rather than duplicated: a user's detail lists its
 * keys and deleting a user deletes them, and the `key_meta` bookkeeping that goes
 * with both belongs in one service.
 */
@Module({
  imports: [IamCoreModule, AccessKeysModule],
  controllers: [IamUsersController],
  providers: [IamUsersService],
  exports: [IamUsersService],
})
export class IamUsersModule {}
