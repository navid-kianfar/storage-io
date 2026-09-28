import { createZodDto } from 'nestjs-zod';
import type { z } from 'zod';

/**
 * Turns a contract schema into a Nest DTO class: the global `ZodValidationPipe`
 * validates against it and `@nestjs/swagger` reads its OpenAPI shape from the
 * same schema. The contract stays the single source of truth — no DTO restates a
 * field, so a schema and a DTO can never disagree.
 */
export const dtoFrom = <TSchema extends z.ZodType>(schema: TSchema) => createZodDto(schema);
