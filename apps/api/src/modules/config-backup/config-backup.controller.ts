import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { exportSettingsRequestSchema, type ImportSettingsResponse } from '@storage-io/contracts';
import { dtoFrom } from '../../common/dto';
import { LogActivity } from '../../activity/activity.interceptor';
import { ValidationError } from '../../common/errors/domain.exception';
import { ConfigBackupService } from './config-backup.service';
import { MAX_ARCHIVE_BYTES } from './config-archive';

class ExportSettingsDto extends dtoFrom(exportSettingsRequestSchema) {}

/** The minimum the contract sets for a passphrase, restated for the multipart path. */
const PASSPHRASE_MIN_LENGTH = 8;
const PASSPHRASE_MAX_LENGTH = 1024;
const ARCHIVE_CONTENT_TYPE = 'application/octet-stream';

/**
 * `POST /settings/export` and `POST /settings/import`.
 *
 * A second controller on the `settings` path rather than more routes on
 * `SettingsController`: these two are the only endpoints in the API that speak
 * binary and multipart, they need the server repository and the crypto service that
 * the settings module has no business knowing about, and `@Controller('settings')`
 * twice is how Nest expresses exactly that.
 *
 * **Import is a multipart form, so it does not pass through `ZodValidationPipe`** —
 * the pipe validates a parsed JSON body and there is none here. The two fields are
 * therefore validated by hand, to the same bounds the contract sets, which is why
 * `PASSPHRASE_MIN_LENGTH` is restated above rather than inferred.
 */
@ApiTags('settings')
@Controller('settings')
export class ConfigBackupController {
  constructor(private readonly backup: ConfigBackupService) {}

  @Post('export')
  @HttpCode(HttpStatus.OK)
  @LogActivity({
    category: 'system',
    action: 'settings.export',
    title: 'Exported the configuration',
  })
  @ApiOperation({ summary: 'Download every setting and server, encrypted with a passphrase' })
  async export(@Body() body: ExportSettingsDto, @Res() response: Response): Promise<void> {
    const archive = await this.backup.export(body.passphrase);
    const stamp = new Date().toISOString().slice(0, 10);

    response.setHeader('Content-Type', ARCHIVE_CONTENT_TYPE);
    response.setHeader('Content-Disposition', `attachment; filename="storage-io-${stamp}.sioconf"`);
    response.setHeader('Content-Length', String(archive.length));
    // The archive contains every credential the installation holds; a cache of it
    // anywhere between here and the operator's disk would be a copy nobody manages.
    response.setHeader('Cache-Control', 'no-store');
    response.end(archive);
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    // Memory storage, bounded: the archive is kilobytes, and writing a file full of
    // credentials to a temp directory would leave it there after the request.
    FileInterceptor('file', { limits: { fileSize: MAX_ARCHIVE_BYTES, files: 1 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'passphrase'],
      properties: {
        file: { type: 'string', format: 'binary' },
        passphrase: { type: 'string' },
      },
    },
  })
  @LogActivity({
    category: 'system',
    action: 'settings.import',
    title: 'Imported a configuration archive',
  })
  @ApiOperation({ summary: 'Restore settings and server connections from an archive' })
  async import(
    @UploadedFile() file: UploadedArchive | undefined,
    @Body('passphrase') passphrase: unknown,
  ): Promise<ImportSettingsResponse> {
    if (file === undefined || file.buffer.length === 0) {
      throw new ValidationError('Attach the archive as the `file` field of a multipart form.');
    }
    if (
      typeof passphrase !== 'string' ||
      passphrase.length < PASSPHRASE_MIN_LENGTH ||
      passphrase.length > PASSPHRASE_MAX_LENGTH
    ) {
      throw new ValidationError(
        `\`passphrase\` must be between ${PASSPHRASE_MIN_LENGTH} and ${PASSPHRASE_MAX_LENGTH} characters.`,
      );
    }

    return this.backup.import(file.buffer, passphrase);
  }
}

/**
 * Only the two fields this handler reads. Declaring them beats
 * `Express.Multer.File`, which pulls multer's global namespace into every file that
 * imports this one.
 */
interface UploadedArchive {
  readonly buffer: Buffer;
  readonly originalname: string;
}
