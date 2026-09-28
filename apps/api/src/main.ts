import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { API_PREFIX } from '@storage-io/contracts';
import { createApp } from './bootstrap';
import { AppConfigService } from './config/app-config.service';
import { EnvValidationError } from './config/env.schema';

async function main(): Promise<void> {
  const app = await createApp();
  const config = app.get(AppConfigService);

  await app.listen(config.port, config.host);

  new Logger('Bootstrap').log(
    `storage-io API listening on http://${config.host}:${config.port}${API_PREFIX}`,
  );
}

main().catch((error: unknown) => {
  // A bad environment is the common startup failure, and a zod stack trace is
  // the least helpful way to report it. Print the list and exit.
  if (error instanceof EnvValidationError) {
    process.stderr.write(
      `\nstorage-io could not start.\n${error.message}\n\nSee .env.example.\n\n`,
    );
    process.exit(1);
  }

  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`\nstorage-io failed to start.\n${message}\n\n`);
  process.exit(1);
});
