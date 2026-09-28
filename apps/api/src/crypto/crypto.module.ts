import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';

/**
 * Global: the auth, servers and settings modules all need it, and a service with
 * no state beyond a derived key has no reason to exist more than once.
 */
@Global()
@Module({
  providers: [CryptoService],
  exports: [CryptoService],
})
export class CryptoModule {}
