import {
  createApiTokenRequestSchema,
  loginRequestSchema,
  revokeSessionsQuerySchema,
  updateMeRequestSchema,
} from '@storage-io/contracts';
import { dtoFrom } from '../common/dto';

export class LoginDto extends dtoFrom(loginRequestSchema) {}
export class UpdateMeDto extends dtoFrom(updateMeRequestSchema) {}
export class CreateApiTokenDto extends dtoFrom(createApiTokenRequestSchema) {}
export class RevokeSessionsQueryDto extends dtoFrom(revokeSessionsQuerySchema) {}
