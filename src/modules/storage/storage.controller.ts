import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  Query,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { StorageService } from './storage.service';
import { memoryStorage } from 'multer';

@ApiTags('Storage')
@ApiBearerAuth()
@Controller('storage')
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Post('upload')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB guard at multer level
    }),
  )
  @ApiOperation({
    summary: 'Upload a file to Cloudinary',
    description:
      'Accepts images (JPEG, PNG, WEBP, GIF) and PDFs up to 10 MB. ' +
      'Returns a secure URL to use when submitting KYC docs, product images, etc. ' +
      'Use the `folder` query param to organise uploads (e.g. `kyc`, `products`, `profile`).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
      required: ['file'],
    },
  })
  @ApiQuery({
    name: 'folder',
    required: false,
    description: 'Cloudinary folder name (default: general)',
    example: 'kyc',
  })
  @ApiResponse({
    status: 200,
    description:
      'File uploaded — returns { url, secureUrl, publicId, format, bytes, folder }',
  })
  @ApiResponse({
    status: 400,
    description: 'No file, wrong file type, or file too large',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Query('folder') folder: string = 'general',
  ) {
    if (!file) {
      throw new BadRequestException(
        'No file was attached. Send file as multipart/form-data with field name "file".',
      );
    }
    return this.storageService.uploadFile(file, folder);
  }
}
