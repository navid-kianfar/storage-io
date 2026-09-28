import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { API_PREFIX, type HealthResponse } from '@storage-io/contracts';
import { Public } from '../common/decorators/public.decorator';
import { APP_VERSION } from '../version';

/**
 * The two paths the same probe answers on, and why there are two.
 *
 * `/health` is outside the version prefix because it is what supervises the
 * process — the Docker `HEALTHCHECK`, a load balancer, an operator with `curl` —
 * and a version segment there only gives that machinery one more thing to get
 * wrong. `/api/v1/health` is the one docs/API.md documents, so a client that
 * builds every URL from the base path can reach it without a special case.
 *
 * Both are declared here and both are in `createApp`'s `exclude` list, because
 * the global prefix would otherwise turn the second into `/api/v1/api/v1/health`.
 */
export const HEALTH_PATHS = ['health', `${API_PREFIX.slice(1)}/health`] as const;

/**
 * The only unauthenticated endpoint. `/health` is also exempt from the
 * allowed-networks middleware, so an operator who has locked themselves out of
 * the CIDR list can still see whether the API is alive; the prefixed path is not,
 * because it is the app's own and the network policy is meant to apply to it.
 *
 * It reports liveness only — no database, provider or settings state. A probe
 * that fails because one storage server is unreachable would restart a healthy
 * API.
 */
@ApiTags('health')
@Controller([...HEALTH_PATHS])
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
