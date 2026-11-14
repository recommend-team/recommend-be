import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Repository } from 'typeorm';
import { User } from '../auth/entities/auth.entity';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Role } from '../../common/enums/roles.enum';
import { StorageService } from '../storage/storage.service';
import { isKycDocument, KYC_DOCUMENTS } from '../storage/kyc-ref';

/**
 * Viewing someone's identity document. Stored privately, so the only way to open one is
 * a link from here, which stops working after five minutes — and every view is logged,
 * with who looked at whose.
 */
@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/users')
@Roles(Role.ADMIN)
export class AdminKycController {
  private readonly logger = new Logger(AdminKycController.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly storage: StorageService,
  ) {}

  @Get(':id/kyc/:document')
  @ApiOperation({
    summary: 'A short-lived link to one identity document',
    description: `Documents: ${KYC_DOCUMENTS.join(', ')}. The link works for five minutes.`,
  })
  @ApiParam({ name: 'id', description: 'User id' })
  @ApiParam({ name: 'document', enum: KYC_DOCUMENTS })
  @ApiResponse({ status: 200, description: '{ url, expiresAt }' })
  @ApiResponse({
    status: 404,
    description: 'No such user, or no such document',
  })
  async view(
    @CurrentUser() admin: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('document') document: string,
  ) {
    if (!isKycDocument(document)) {
      throw new BadRequestException('Unknown document');
    }
    const user = await this.users.findOne({
      where: { id },
      select: ['id', document],
    });
    const link = this.storage.kycViewUrl(user?.[document]);
    if (!user || !link) throw new NotFoundException('No such document');

    this.logger.log(`Admin ${admin.id} viewed ${document} of user ${id}`);
    return {
      message: 'Link ready',
      data: { url: link.url, expiresAt: link.expiresAt || null },
    };
  }
}
