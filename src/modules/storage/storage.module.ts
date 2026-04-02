import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

@Module({
  imports: [MulterModule.register({ storage: memoryStorage() })],
  controllers: [StorageController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
