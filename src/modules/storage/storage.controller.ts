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
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Role } from '../../common/enums/roles.enum';
import type { User } from '../auth/entities/auth.entity';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMINS: string[] = [Role.ADMIN, Role.SUPER_ADMIN];
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

  @Post('kyc')
  @Roles(Role.SELLER, Role.RIDER)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  @ApiOperation({
    summary: 'Upload an identity document, privately',
    description:
      'For KYC documents only. Stored privately — there is no public link. Returns a ' +
      '`ref` to submit on the account; admins view it through ' +
      'GET /admin/users/:id/kyc/:document. Vendors and riders upload their own; an ' +
      'admin uploads for someone with `?for=<user id>`.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiQuery({
    name: 'for',
    required: false,
    description: 'Admins only: whose document this is',
  })
  @ApiResponse({ status: 200, description: '{ ref, format, bytes }' })
  async uploadKyc(
    @CurrentUser() user: User,
    @UploadedFile() file: Express.Multer.File,
    @Query('for') forUserId?: string,
  ) {
    let ownerId = user.id;
    if (forUserId) {
      if (!ADMINS.includes(user.role) || !UUID.test(forUserId)) {
        throw new BadRequestException(
          'Only an admin can upload for someone else.',
        );
      }
      ownerId = forUserId.toLowerCase();
    }
    return this.storageService.uploadKycDocument(file, ownerId);
  }
}
