import { Module } from '@nestjs/common';
import { MediaStorageFactory } from '@waha/core/media/MediaStorageFactory';
import { MediaS3StorageConfig } from '@waha/plus/media/s3/MediaS3StorageConfig';
import { MediaS3StorageFactory } from '@waha/plus/media/s3/MediaS3StorageFactory';

@Module({
  providers: [
    {
      provide: MediaStorageFactory,
      useClass: MediaS3StorageFactory,
    },
    MediaS3StorageConfig,
  ],
  exports: [MediaStorageFactory],
})
export class MediaS3StorageModule {}
