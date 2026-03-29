import { Injectable } from '@nestjs/common';

@Injectable()
export class MediaS3StorageConfig {
  get region(): string {
    return process.env.WAHA_S3_REGION || 'us-east-1';
  }

  get bucket(): string {
    return process.env.WAHA_S3_BUCKET || 'waha';
  }

  get accessKeyId(): string {
    return process.env.WAHA_S3_ACCESS_KEY_ID;
  }

  get secretAccessKey(): string {
    return process.env.WAHA_S3_SECRET_ACCESS_KEY;
  }

  get endpoint(): string | undefined {
    return process.env.WAHA_S3_ENDPOINT;
  }

  get forcePathStyle(): boolean {
    const val = process.env.WAHA_S3_FORCE_PATH_STYLE;
    return val === 'True' || val === 'true' || val === '1';
  }

  get proxyFiles(): boolean {
    const val = process.env.WAHA_S3_PROXY_FILES;
    return val === 'True' || val === 'true' || val === '1';
  }

  get baseUrl(): string {
    return process.env.WAHA_BASE_URL || 'http://localhost:3000';
  }
}
