import { Injectable } from '@nestjs/common';
import { IMediaStorage } from '@waha/core/media/IMediaStorage';
import { MediaStorageFactory } from '@waha/core/media/MediaStorageFactory';
import { MediaS3Storage } from '@waha/plus/media/s3/MediaS3Storage';
import { MediaS3StorageConfig } from '@waha/plus/media/s3/MediaS3StorageConfig';
import { Logger } from 'pino';

@Injectable()
export class MediaS3StorageFactory extends MediaStorageFactory {
  constructor(private config: MediaS3StorageConfig) {
    super();
  }

  async build(name: string, logger: Logger): Promise<IMediaStorage> {
    // All sessions share the same S3 config/client
    return new MediaS3Storage(logger, this.config);
  }
}
