import { Module } from '@nestjs/common';
import { ApiTokenService } from './api-token.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';

/**
 * `SessionService` and `ApiTokenService` are exported because the global
 * `AuthGuard` resolves them: the guard lives in `common/` but its credentials
 * come from here.
 */
@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionService, ApiTokenService],
  exports: [SessionService, ApiTokenService],
})
export class AuthModule {}
