import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { HealthResponse } from '@storage-io/contracts';
import { Public } from '../common/decorators/public.decorator';
import { APP_VERSION } from '../version';

/**
 * The only unauthenticated endpoint. It is also exempt from the allowed-networks
 * middleware, so an operator who has locked themselves out of the CIDR list can
 * still see whether the API is alive.
 *
 * It reports liveness only — no database, provider or settings state. A probe
 * that fails because one storage server is unreachable would restart a healthy
 * API.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  @Get()
  @Public()
  @ApiOperation({ summary: 'Liveness probe (public)' })
  health(): HealthResponse {
    return {
      status: 'ok',
      version: APP_VERSION,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }
}
