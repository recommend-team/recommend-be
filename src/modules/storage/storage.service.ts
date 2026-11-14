import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { kycFolder, parseKycRef, toKycRef } from './kyc-ref';

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

/** How long a link to view an identity document works. */
const KYC_VIEW_SECONDS = 5 * 60;

export interface KycUploadResult {
  /** What to save on the account — not a link; see `kyc-ref.ts`. */
  ref: string;
  format: string;
  bytes: number;
}

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
    this.check(file);

    const sanitizedFolder =
      folder.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || 'general';
    // Identity documents never go up as public files.
    if (sanitizedFolder.toLowerCase().startsWith('kyc')) {
      throw new BadRequestException(
        'Identity documents are uploaded privately — use POST /storage/kyc.',
      );
    }

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

  /**
   * An identity document, stored privately in its owner's folder: no public link exists,
   * and it opens only through `kycViewUrl`.
   */
  async uploadKycDocument(
    file: Express.Multer.File,
    ownerId: string,
  ): Promise<{ message: string; data: KycUploadResult }> {
    this.check(file);
    try {
      const result = await this.uploadToCloudinary(file.buffer, '', {
        folder: kycFolder(ownerId),
        type: 'private',
      });
      return {
        message: 'Document uploaded',
        data: {
          ref: toKycRef(result.resource_type, result.public_id, result.format),
          format: result.format,
          bytes: result.bytes,
        },
      };
    } catch (error) {
      console.error('Cloudinary KYC upload error:', error);
      throw new InternalServerErrorException(
        'Failed to upload the document. Please try again.',
      );
    }
  }

  /**
   * A link to one identity document that stops working after five minutes. Null when
   * nothing usable is stored. A document saved before uploads went private is still a
   * public link until `scripts/make-kyc-private.ts` converts it, and comes back as it is.
   */
  kycViewUrl(
    stored: string | null | undefined,
  ): { url: string; expiresAt: string; legacy: boolean } | null {
    const ref = parseKycRef(stored);
    if (ref) {
      const expiresAt = Math.floor(Date.now() / 1000) + KYC_VIEW_SECONDS;
      return {
        url: cloudinary.utils.private_download_url(ref.publicId, ref.format, {
          resource_type: ref.resourceType,
          type: 'private',
          expires_at: expiresAt,
        }),
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        legacy: false,
      };
    }
    if (stored?.startsWith('https://res.cloudinary.com/')) {
      return { url: stored, expiresAt: '', legacy: true };
    }
    return null;
  }

  private check(file: Express.Multer.File | undefined): void {
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
  }

  private uploadToCloudinary(
    buffer: Buffer,
    folder: string,
    options: { folder?: string; type?: 'private' } = {},
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      cloudinary.uploader
        .upload_stream(
          {
            folder: options.folder ?? `recommend/${folder}`,
            ...(options.type ? { type: options.type } : {}),
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
