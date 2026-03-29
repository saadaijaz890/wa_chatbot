import {
  getMetadata,
  IMediaStorage,
  MediaData,
  MediaStorageData,
} from '@waha/core/media/IMediaStorage';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Logger } from 'pino';
import { MediaS3StorageConfig } from '@waha/plus/media/s3/MediaS3StorageConfig';

export class MediaS3Storage extends IMediaStorage {
  private readonly client: S3Client;

  constructor(
    protected log: Logger,
    private config: MediaS3StorageConfig,
  ) {
    super();
    this.client = new S3Client({
      region: config.region,
      credentials:
        config.accessKeyId && config.secretAccessKey
          ? {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            }
          : undefined,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
    });
  }

  async init(): Promise<void> {
    this.log.info('S3 storage initialized');
  }

  async save(buffer: Buffer, data: MediaData): Promise<boolean> {
    const key = this.getKey(data);
    const metadata = getMetadata(data);

    // Convert metadata values to strings (S3 requires string metadata values)
    const stringMetadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(metadata)) {
      if (v !== undefined && v !== null) {
        stringMetadata[k] = String(v);
      }
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: buffer,
        Metadata: stringMetadata,
      }),
    );
    return true;
  }

  async exists(data: MediaData): Promise<boolean> {
    const key = this.getKey(data);
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
        }),
      );
      return true;
    } catch (err: any) {
      if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw err;
    }
  }

  async getStorageData(data: MediaData): Promise<MediaStorageData> {
    const key = this.getKey(data);
    const bucket = this.config.bucket;

    let url: string;
    if (this.config.proxyFiles) {
      url = `${this.config.baseUrl}/api/s3/${key}`;
    } else if (this.config.endpoint) {
      url = `${this.config.endpoint}/${bucket}/${key}`;
    } else {
      url = `https://${bucket}.s3.${this.config.region}.amazonaws.com/${key}`;
    }

    return {
      url,
      s3: {
        Bucket: bucket,
        Key: key,
      },
    };
  }

  async purge(): Promise<void> {
    this.log.info(
      'Purge is not needed for S3 storage - use S3 lifecycle policies to manage object expiration',
    );
  }

  async close(): Promise<void> {
    return;
  }

  private getKey(data: MediaData): string {
    return `${data.session}/${data.message.id}.${data.file.extension}`;
  }
}
