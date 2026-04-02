import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';

export interface UploadResult {
  url: string;
  secureUrl: string;
  publicId: string;
  format: string;
  bytes: number;
  folder: string;
}

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

@Injectable()
export class StorageService {
  constructor(private readonly configService: ConfigService) {
    cloudinary.config({
      cloud_name: this.configService.get<string>('cloudinary.cloudName'),
      api_key: this.configService.get<string>('cloudinary.apiKey'),
      api_secret: this.configService.get<string>('cloudinary.apiSecret'),
    });
  }

  async uploadFile(
    file: Express.Multer.File,
    folder: string = 'general',
  ): Promise<{ message: string; data: UploadResult }> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        `File type not allowed. Accepted types: ${ALLOWED_MIME_TYPES.join(', ')}`,
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException('File size must not exceed 10 MB');
    }

    const sanitizedFolder =
      folder.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || 'general';

    try {
      const result = await this.uploadToCloudinary(
        file.buffer,
        sanitizedFolder,
      );

      return {
        message: 'File uploaded successfully',
        data: {
          url: result.url,
          secureUrl: result.secure_url,
          publicId: result.public_id,
          format: result.format,
          bytes: result.bytes,
          folder: sanitizedFolder,
        },
      };
    } catch (error) {
      console.error('Cloudinary upload error:', error);
      throw new InternalServerErrorException(
        'Failed to upload file. Please try again.',
      );
    }
  }

  private uploadToCloudinary(
    buffer: Buffer,
    folder: string,
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream(
          {
            folder: `recommend/${folder}`,
            resource_type: 'auto',
            allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'pdf'],
          },
          (error, result) => {
            if (error || !result)
              return reject(new Error(error?.message ?? 'Upload failed'));
            resolve(result);
          },
        )
        .end(buffer);
    });
  }
}
