import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { User } from '../auth/entities/auth.entity';
import { PendingUser } from '../auth/entities/pending-user.entity';
import { Product } from '../products/entities/product.entity';
import { AuthService } from '../auth/auth.service';
import { SellersService } from '../sellers/sellers.service';
import { ProductsService } from '../products/products.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PushService } from '../notifications/push.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { EmailService } from '../../common/services/email.service';
import { Role } from '../../common/enums/roles.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';
import { VendorType } from '../../common/enums/vendor-type.enum';
import { uniqueSlug } from '../../common/utils/slug.util';
import {
  VendorAdminAction,
  VendorAdminEdit,
} from './entities/vendor-admin-edit.entity';
import {
  OWNER_FIELDS,
  type AdminUpdateVendorDto,
  type CreateVendorDto,
} from './dto/admin-vendor.dto';
import type { CreateProductDto } from '../products/dto/create-product.dto';
import type { UpdateProductDto } from '../products/dto/update-product.dto';
import type { UpdateProfileDto } from '../sellers/dto/update-profile.dto';
import {
  updateNonRegisteredKycSchema,
  updateRegisteredKycSchema,
  type UpdateNonRegisteredKycDto,
  type UpdateRegisteredKycDto,
} from '../sellers/dto/update-kyc.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipes';

/** How each store field reads in a summary or a notification. */
const FIELD_LABELS: Record<string, string> = {
  businessName: 'business name',
  businessAddress: 'address',
  businessDescription: 'description',
  businessCategory: 'what you sell',
  areaIds: 'delivery areas',
  businessLogoUrl: 'logo',
  businessBannerUrl: 'banner',
  whatsappNumber: 'WhatsApp number',
  isOpen: 'open / closed',
  operatingHours: 'opening hours',
  firstName: 'first name',
  lastName: 'last name',
  phoneNumber: 'phone number',
  vendorType: 'registered or not',
  orderQuota: 'monthly order limit',
  name: 'name',
  description: 'description',
  price: 'price',
  imageUrl: 'photo',
  isAvailable: 'available',
  isAddOn: 'extra',
  unit: 'unit',
  extraIds: 'extras',
  dishIds: 'dishes it goes on',
  choices: 'choices',
};

function labelled(fields: string[]): string {
  const labels = fields.map((field) => FIELD_LABELS[field] ?? field);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** What a monthly order limit starts at for a vendor who is not a registered business. */
const NON_REGISTERED_QUOTA = 20;

/**
 * An admin running a vendor's account for them — everything but money.
 *
 * Each action goes through the vendor's own code (`SellersService`, `ProductsService`), so
 * a store the admin saves obeys the same rules as one the vendor saves. On top of that,
 * every action is logged (`vendor_admin_edits`, "who changed this price?") and the vendor
 * is told in the vendor app, once per save.
 *
 * Payout accounts, withdrawals and the wallet are deliberately absent.
 */
@Injectable()
export class AdminVendorsService {
  private readonly logger = new Logger(AdminVendorsService.name);

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(PendingUser)
    private readonly pendingUsers: Repository<PendingUser>,
    @InjectRepository(Product)
    private readonly products: Repository<Product>,
    @InjectRepository(VendorAdminEdit)
    private readonly edits: Repository<VendorAdminEdit>,
    private readonly auth: AuthService,
    private readonly sellers: SellersService,
    private readonly productsService: ProductsService,
    private readonly notifications: NotificationsService,
    private readonly push: PushService,
    private readonly email: EmailService,
  ) {}

  // ─── The account ───────────────────────────────────────────────────────────

  /**
   * Sets up a vendor who has not signed up themselves — someone onboarded in person.
   *
   * Approved and verified straight away (an admin vetted them), open, with a shop link.
   * No password: they are emailed a link to choose one, and cannot sign in until they do.
   */
  async createVendor(adminId: string, dto: CreateVendorDto) {
    await this.assertEmailFree(dto.email);
    await this.assertPhoneFree(dto.phoneNumber);

    const vendor = await this.users.save(
      this.users.create({
        email: dto.email,
        password: null,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phoneNumber: dto.phoneNumber,
        role: Role.SELLER,
        status: SellerStatus.APPROVED,
        vendorType: dto.vendorType,
        orderQuota:
          dto.vendorType === VendorType.NON_REGISTERED
            ? NON_REGISTERED_QUOTA
            : null,
        isEmailVerified: true,
        emailVerifiedAt: new Date(),
        businessName: dto.businessName,
        businessAddress: dto.businessAddress,
        businessCategory: dto.businessCategory,
        businessDescription: dto.businessDescription ?? null,
        slug: await uniqueSlug(dto.businessName, (slug) =>
          this.users.exists({ where: { slug } }),
        ),
      }),
    );

    if (dto.areaIds?.length) {
      await this.sellers.updateProfile(vendor.id, { areaIds: dto.areaIds });
    }

    const invited = await this.auth.sendSetPasswordLink(vendor, 'invite');
    await this.record(adminId, vendor.id, VendorAdminAction.CREATED, {
      summary: `Set up ${dto.businessName}${invited ? ' and emailed an invite' : ' — the invite email did not send'}`,
    });

    return {
      message: invited
        ? `Vendor created. ${dto.email} has been emailed a link to set their password.`
        : 'Vendor created, but the invite email did not send. Use "Send set-password email" to try again.',
      data: { ...(await this.profileOf(vendor.id)), inviteSent: invited },
    };
  }

  /**
   * Changes the store (the vendor's own fields, through their own update) and the owner's
   * details the vendor app cannot change. One log entry and one notice per save.
   */
  async updateVendor(
    adminId: string,
    vendorId: string,
    dto: AdminUpdateVendorDto,
  ) {
    const vendor = await this.findVendor(vendorId);

    const owner: Partial<User> = {};
    const store: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(dto)) {
      if (value === undefined) continue;
      if ((OWNER_FIELDS as readonly string[]).includes(field)) {
        (owner as Record<string, unknown>)[field] = value;
      } else {
        store[field] = value;
      }
    }

    if (
      owner.phoneNumber !== undefined &&
      owner.phoneNumber !== vendor.phoneNumber
    ) {
      await this.assertPhoneFree(owner.phoneNumber!, vendor.id);
    }
    if (Object.keys(owner).length > 0) {
      await this.users.update(vendor.id, owner);
    }
    if (Object.keys(store).length > 0) {
      await this.sellers.updateProfile(vendor.id, store as UpdateProfileDto);
    }

    const ownerFields = Object.keys(owner);
    const storeFields = Object.keys(store);
    if (storeFields.length > 0) {
      await this.record(adminId, vendor.id, VendorAdminAction.STORE_UPDATED, {
        summary: `Changed ${labelled(storeFields)}`,
        changes: store,
      });
    }
    if (ownerFields.length > 0) {
      await this.record(adminId, vendor.id, VendorAdminAction.OWNER_UPDATED, {
        summary: `Changed ${labelled(ownerFields)}`,
        changes: owner as Record<string, unknown>,
      });
    }
    await this.tellVendor(vendor.id, {
      title: 'Recommend updated your store',
      body: `We changed your ${labelled([...storeFields, ...ownerFields])}.`,
      url: storeFields.length > 0 ? '/store' : '/dashboard',
    });

    return {
      message: 'Vendor updated',
      data: await this.profileOf(vendor.id),
    };
  }

  /** The login email. The old address is told, since it stops working at once. */
  async changeEmail(adminId: string, vendorId: string, email: string) {
    const vendor = await this.findVendor(vendorId);
    if (email === vendor.email) {
      throw new BadRequestException('That is already their email');
    }
    await this.assertEmailFree(email, vendor.id);

    const oldEmail = vendor.email;
    await this.users.update(vendor.id, {
      email,
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    });

    await this.email
      .sendEmail({
        to: oldEmail,
        subject: 'Your Recommend login email was changed',
        template: 'login-email-changed',
        context: { name: vendor.firstName, newEmail: email },
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `Could not tell ${oldEmail} their login email changed: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        ),
      );
    await this.record(adminId, vendor.id, VendorAdminAction.EMAIL_CHANGED, {
      summary: `Changed login email from ${oldEmail} to ${email}`,
      changes: { email },
    });

    return {
      message: `Login email changed to ${email}. ${oldEmail} has been told.`,
      data: await this.profileOf(vendor.id),
    };
  }

  /**
   * Emails a link to set a password — the invite again, for a vendor who never set one, or
   * a fresh link for one who is locked out. Also lifts a lock-out once they use it.
   */
  async sendInvite(adminId: string, vendorId: string) {
    const vendor = await this.users.findOne({
      where: { id: vendorId, role: Role.SELLER },
      select: [
        'id',
        'email',
        'firstName',
        'role',
        'businessName',
        'password',
        'status',
      ],
    });
    if (!vendor) throw new NotFoundException('Vendor not found');
    if (vendor.status === SellerStatus.DEACTIVATED) {
      throw new BadRequestException(
        'This vendor is deactivated. Reactivate them first.',
      );
    }

    const kind = vendor.password ? 'reset' : 'invite';
    const sent = await this.auth.sendSetPasswordLink(vendor, kind);
    if (!sent) {
      throw new BadRequestException(
        'The email did not send. Check the address and try again.',
      );
    }
    await this.record(adminId, vendor.id, VendorAdminAction.INVITE_SENT, {
      summary:
        kind === 'invite'
          ? `Sent the set-password invite to ${vendor.email}`
          : `Sent a new set-password link to ${vendor.email}`,
    });
    return {
      message: `A link to set their password has been emailed to ${vendor.email}.`,
      data: null,
    };
  }

  /**
   * KYC document links, through the vendor's own update. Which documents are accepted
   * follows the vendor's type — a registered business's CAC and TIN, or an individual's
   * ID, photo, statement and bill — checked against that type's rules here.
   */
  async updateKyc(adminId: string, vendorId: string, raw: unknown) {
    const vendor = await this.findVendor(vendorId);
    if (!vendor.vendorType) {
      throw new BadRequestException(
        'Set whether this vendor is a registered business first.',
      );
    }
    const schema =
      vendor.vendorType === VendorType.REGISTERED
        ? updateRegisteredKycSchema
        : updateNonRegisteredKycSchema;
    const body = new ZodValidationPipe(schema).transform(raw) as
      | UpdateRegisteredKycDto
      | UpdateNonRegisteredKycDto;
    await this.sellers.updateKyc(vendor.id, body);

    const fields = Object.keys(body);
    await this.record(adminId, vendor.id, VendorAdminAction.KYC_UPDATED, {
      summary: `Uploaded ${fields.length === 1 ? 'a document' : `${fields.length} documents`}`,
      changes: body as Record<string, unknown>,
    });
    await this.tellVendor(vendor.id, {
      title: 'Recommend added your documents',
      body: 'We uploaded verification documents to your account.',
      url: '/kyc',
    });
    return {
      message: 'Documents saved',
      data: await this.profileOf(vendor.id),
    };
  }

  /**
   * "Removes" a vendor: deactivated — cannot sign in, gone from buyers, shop link closed.
   * Their orders and ledger stay pointing at them. Reactivate undoes it.
   */
  async deactivate(adminId: string, vendorId: string, reason?: string) {
    const vendor = await this.findVendor(vendorId);
    if (vendor.status === SellerStatus.DEACTIVATED) {
      throw new BadRequestException('This vendor is already deactivated');
    }
    await this.users.update(vendor.id, {
      status: SellerStatus.DEACTIVATED,
      isOpen: false,
    });
    await this.record(adminId, vendor.id, VendorAdminAction.DEACTIVATED, {
      summary: reason?.trim()
        ? `Deactivated — ${reason.trim()}`
        : 'Deactivated',
    });
    return {
      message: `${vendor.businessName ?? 'The vendor'} is deactivated. Reactivate them to undo it.`,
      data: await this.profileOf(vendor.id),
    };
  }

  // ─── Products ──────────────────────────────────────────────────────────────

  async listProducts(vendorId: string, page?: number, limit?: number) {
    await this.findVendor(vendorId);
    return this.productsService.findAllByVendor(vendorId, { page, limit });
  }

  async addProduct(adminId: string, vendorId: string, dto: CreateProductDto) {
    await this.findVendor(vendorId);
    const created = await this.productsService.create(vendorId, dto);
    await this.record(adminId, vendorId, VendorAdminAction.PRODUCT_ADDED, {
      summary: `Added ${dto.name}`,
      changes: { productId: created.data.id, ...dto },
    });
    await this.tellVendor(vendorId, {
      title: 'Recommend added a product',
      body: `We added ${dto.name} to your shop.`,
      url: `/products/${created.data.id}`,
    });
    return created;
  }

  async updateProduct(
    adminId: string,
    vendorId: string,
    productId: string,
    dto: UpdateProductDto,
  ) {
    await this.findVendor(vendorId);
    const updated = await this.productsService.update(vendorId, productId, dto);
    const name = updated.data?.name ?? 'a product';
    await this.record(adminId, vendorId, VendorAdminAction.PRODUCT_UPDATED, {
      summary: `Changed ${labelled(Object.keys(dto))} on ${name}`,
      changes: { productId, ...dto },
    });
    await this.tellVendor(vendorId, {
      title: 'Recommend updated a product',
      body: `We changed the ${labelled(Object.keys(dto))} of ${name}.`,
      url: `/products/${productId}`,
    });
    return updated;
  }

  async removeProduct(adminId: string, vendorId: string, productId: string) {
    await this.findVendor(vendorId);
    const product = await this.products.findOne({
      where: { id: productId, vendorId },
      select: ['id', 'name'],
    });
    const result = await this.productsService.remove(vendorId, productId);
    const name = product?.name ?? 'a product';
    await this.record(adminId, vendorId, VendorAdminAction.PRODUCT_REMOVED, {
      summary: `Removed ${name}`,
      changes: { productId },
    });
    await this.tellVendor(vendorId, {
      title: 'Recommend removed a product',
      body: `We removed ${name} from your shop.`,
      url: '/products',
    });
    return result;
  }

  // ─── History ───────────────────────────────────────────────────────────────

  /** What admins have done to this vendor, newest first, with who did it. */
  async history(vendorId: string, limit = 50) {
    await this.findVendor(vendorId);
    const rows: {
      id: string;
      action: VendorAdminAction;
      summary: string;
      createdAt: Date;
      adminId: string;
      adminFirstName: string | null;
      adminLastName: string | null;
    }[] = await this.edits
      .createQueryBuilder('edit')
      .leftJoin(User, 'admin', 'admin.id = edit.adminId')
      .select([
        'edit.id AS id',
        'edit.action AS action',
        'edit.summary AS summary',
        'edit.createdAt AS "createdAt"',
        'edit.adminId AS "adminId"',
        'admin.firstName AS "adminFirstName"',
        'admin.lastName AS "adminLastName"',
      ])
      .where('edit.vendorId = :vendorId', { vendorId })
      .orderBy('edit.createdAt', 'DESC')
      .limit(Math.min(200, Math.max(1, limit)))
      .getRawMany();

    return {
      message: 'History',
      data: rows.map((row) => ({
        id: row.id,
        action: row.action,
        summary: row.summary,
        createdAt: new Date(row.createdAt).toISOString(),
        admin: {
          id: row.adminId,
          name:
            `${row.adminFirstName ?? ''} ${row.adminLastName ?? ''}`.trim() ||
            'An admin',
        },
      })),
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async findVendor(vendorId: string): Promise<User> {
    const vendor = await this.users.findOne({
      where: { id: vendorId, role: Role.SELLER },
    });
    if (!vendor) throw new NotFoundException('Vendor not found');
    return vendor;
  }

  private async profileOf(vendorId: string) {
    return (await this.sellers.getProfile(vendorId)).data;
  }

  /** Free among accounts and sign-ups still verifying their email. */
  private async assertEmailFree(email: string, exceptUserId?: string) {
    const [user, pending] = await Promise.all([
      this.users.findOne({
        where: exceptUserId ? { email, id: Not(exceptUserId) } : { email },
        select: ['id'],
        withDeleted: true,
      }),
      this.pendingUsers.findOne({ where: { email }, select: ['id'] }),
    ]);
    if (user || pending) {
      throw new ConflictException(`${email} already belongs to an account`);
    }
  }

  private async assertPhoneFree(phoneNumber: string, exceptUserId?: string) {
    const [user, pending] = await Promise.all([
      this.users.findOne({
        where: exceptUserId
          ? { phoneNumber, id: Not(exceptUserId) }
          : { phoneNumber },
        select: ['id'],
        withDeleted: true,
      }),
      this.pendingUsers.findOne({ where: { phoneNumber }, select: ['id'] }),
    ]);
    if (user || pending) {
      throw new ConflictException(
        `${phoneNumber} already belongs to an account`,
      );
    }
  }

  private async record(
    adminId: string,
    vendorId: string,
    action: VendorAdminAction,
    entry: { summary: string; changes?: Record<string, unknown> | null },
  ): Promise<void> {
    try {
      await this.edits.save(
        this.edits.create({
          adminId,
          vendorId,
          action,
          summary: entry.summary.slice(0, 1000),
          changes: entry.changes ?? null,
        }),
      );
    } catch (error) {
      // The change itself is saved; losing its log line must not undo it.
      this.logger.error(
        `Could not log ${action} on vendor ${vendorId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  /** One notice per save, in the vendor app's feed and as a push. Never throws. */
  private async tellVendor(
    vendorId: string,
    notice: { title: string; body: string; url: string },
  ): Promise<void> {
    try {
      await this.notifications.create({
        userId: vendorId,
        type: NotificationType.STORE_UPDATED_BY_ADMIN,
        title: notice.title,
        body: notice.body,
        data: { url: notice.url },
      });
      await this.push.sendToUser(vendorId, {
        title: notice.title,
        body: notice.body,
        type: NotificationType.STORE_UPDATED_BY_ADMIN,
        url: notice.url,
        tag: `admin-edit:${vendorId}`,
      });
    } catch (error) {
      this.logger.warn(
        `Could not tell vendor ${vendorId} about an admin change: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
