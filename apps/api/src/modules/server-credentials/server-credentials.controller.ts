import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  rotateServerCredentialsRequestSchema,
  type RotateServerCredentialsRequest,
  type RotateServerCredentialsResponse,
} from '@storage-io/contracts';
import { LogActivity } from '../../activity/activity.interceptor';
import { ServerCredentialsService } from './server-credentials.service';

/**
 * `POST /servers/:id/rotate-credentials`, declared here rather than in
 * `ServersController`.
 *
 * The reason is the module graph: this needs the IAM driver, so its module imports
 * `IamCoreModule`, which imports `ServersModule` for the repository. Putting the
 * route in `ServersController` would make `ServersModule` import `IamCoreModule`
 * back and require a `forwardRef` on a module three other modules depend on.
 *
 * The URL is identical either way, and Express matches
 * `/servers/:id/rotate-credentials` ahead of `/servers/:id` because it is a longer,
 * more specific path — there is no ordering interaction between the two controllers.
 *
 * The body is validated with an explicit pipe rather than a `dtoFrom` class, because
 * the request is a discriminated union (`mode: 'auto' | 'manual'`) and
 * `createZodDto` can only build a class from an object schema. The validation and its
 * error envelope are the same either way; only the generated OpenAPI body schema is
 * lost, which is what `@ApiBody` below describes instead.
 */
@ApiTags('servers')
@Controller('servers')
export class ServerCredentialsController {
  constructor(private readonly credentials: ServerCredentialsService) {}

  @Post(':id/rotate-credentials')
  @LogActivity({
    category: 'servers',
    action: 'server.rotate-credentials',
    title: "Rotated a server's stored credentials",
    failureTitle: "Failed to rotate a server's stored credentials",
  })
  @ApiOperation({
    summary:
      'Replace the credential storage-io uses for a server (409 NOT_SUPPORTED without an IAM driver)',
  })
  @ApiBody({
    schema: {
      oneOf: [
        { type: 'object', required: ['mode'], properties: { mode: { enum: ['auto'] } } },
        {
          type: 'object',
          required: ['mode', 'accessKeyId', 'secretAccessKey'],
          properties: {
            mode: { enum: ['manual'] },
            accessKeyId: { type: 'string' },
            secretAccessKey: { type: 'string' },
          },
        },
      ],
    },
  })
  async rotate(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rotateServerCredentialsRequestSchema))
    body: RotateServerCredentialsRequest,
  ): Promise<RotateServerCredentialsResponse> {
    return this.credentials.rotate(id, body);
  }
}
