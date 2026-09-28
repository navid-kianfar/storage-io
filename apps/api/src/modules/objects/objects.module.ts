import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { JobsModule } from '../jobs/jobs.module';
import { QuotasModule } from '../quotas/quotas.module';
import { StorageModule } from '../storage/storage.module';
import { ArchiveReaderService } from './archive-reader.service';
import { MultipartService } from './multipart.service';
import { ObjectDeleteService } from './object-delete.service';
import { ObjectStreamService } from './object-stream.service';
import { ObjectsController } from './objects.controller';
import { ObjectsService } from './objects.service';

/**
 * The object browser's endpoints. `ObjectDeleteService` and `ObjectStreamService`
 * are exported because the buckets module empties a bucket with the same batching
 * primitive — a second implementation of "delete a prefix" is how one of them ends
 * up forgetting delete markers.
 */
@Module({
  imports: [StorageModule, InventoryModule, QuotasModule, JobsModule],
  controllers: [ObjectsController],
  providers: [
    ObjectsService,
    ObjectStreamService,
    ObjectDeleteService,
    MultipartService,
    ArchiveReaderService,
  ],
  exports: [ObjectsService, ObjectStreamService, ObjectDeleteService],
})
export class ObjectsModule {}
