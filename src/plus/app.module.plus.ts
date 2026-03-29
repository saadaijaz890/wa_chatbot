import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  AppModuleCore,
  CONTROLLERS,
  IMPORTS_CORE,
  PROVIDERS_BASE,
} from '@waha/core/app.module.core';
import { SessionManager } from '@waha/core/abc/manager.abc';
import { WAHAHealthCheckService } from '@waha/core/abc/WAHAHealthCheckService';
import { WAHAHealthCheckServiceCore } from '@waha/core/health/WAHAHealthCheckServiceCore';
import { ChannelsInfoServiceCore } from '@waha/core/services/ChannelsInfoServiceCore';
import { SessionManagerPlus } from '@waha/plus/manager.plus';
import { MediaLocalStorageModule } from '@waha/core/media/local/media.local.storage.module';
import { MediaS3StorageModule } from '@waha/plus/media/s3/media.s3.storage.module';
import * as Joi from 'joi';

function getMediaStorageModule() {
  const storage = (process.env.WAHA_MEDIA_STORAGE || 'LOCAL').toUpperCase();
  if (storage === 'S3') {
    return MediaS3StorageModule;
  }
  return MediaLocalStorageModule;
}

const IMPORTS_MEDIA_PLUS = [
  ConfigModule.forRoot({
    validationSchema: Joi.object({
      WAHA_MEDIA_STORAGE: Joi.string()
        .valid('LOCAL', 'S3', 'POSTGRESQL')
        .default('LOCAL'),
    }),
  }),
  getMediaStorageModule(),
];

const PROVIDERS_PLUS = [
  {
    provide: SessionManager,
    useClass: SessionManagerPlus,
  },
  {
    provide: WAHAHealthCheckService,
    useClass: WAHAHealthCheckServiceCore,
  },
  ChannelsInfoServiceCore,
  ...PROVIDERS_BASE,
];

@Module({
  imports: [...IMPORTS_CORE, ...IMPORTS_MEDIA_PLUS],
  controllers: CONTROLLERS,
  providers: PROVIDERS_PLUS,
})
export class AppModulePlus extends AppModuleCore {}
