import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User } from '../../modules/auth/entities/auth.entity';
import { Role, STAFF_ROLES } from '../../common/enums/roles.enum';
import { SellerStatus } from '../../common/enums/seller-status.enum';
import {
  BuyerContact,
  IdentityPort,
  StaffMember,
} from '../ports/identity.port';

const SYNTHETIC_EMAIL_DOMAIN = '@buyers.recommend.ng';

/**
 * Creates and maintains the `users` row behind a chat buyer — this is what "the bot
 * collects their details and saves them" actually means.
 */
@Injectable()
export class LocalIdentityAdapter implements IdentityPort {
  private readonly logger = new Logger(LocalIdentityAdapter.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  async staffMember(id: string): Promise<StaffMember | null> {
    const user = await this.usersRepository.findOne({
      where: { id, role: In([...STAFF_ROLES]) },
    });
    if (!user || !user.canHoldSession()) return null;
    return { id: user.id, role: user.role, name: staffName(user) };
  }

  async staffNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const staff = await this.usersRepository.find({
      where: { id: In(unique), role: In([...STAFF_ROLES]) },
      select: ['id', 'firstName', 'lastName'],
    });
    return new Map(staff.map((user) => [user.id, staffName(user)]));
  }

  async listStaff(): Promise<StaffMember[]> {
    const staff = await this.usersRepository.find({
      where: { role: In([...STAFF_ROLES]) },
      order: { firstName: 'ASC' },
    });
    return staff
      .filter((user) => user.canHoldSession())
      .map((user) => ({ id: user.id, role: user.role, name: staffName(user) }));
  }

  async upsertBuyer(contact: BuyerContact): Promise<{ buyerId: string }> {
    const existing = await this.usersRepository.findOne({
      where: { phoneNumber: contact.phone },
    });

    if (existing) {
      if (existing.role !== Role.BUYER) return { buyerId: existing.id };
      return { buyerId: await this.fillGaps(existing, contact) };
    }

    const { firstName, lastName } = splitName(contact.name);

    const buyer = this.usersRepository.create({
      email: contact.email ?? syntheticEmail(contact.phone),
      password: null,
      firstName,
      lastName,
      phoneNumber: contact.phone,
      role: Role.BUYER,
      // Buyers carry no KYC — APPROVED here simply means "usable", per User.isActive().
      status: SellerStatus.APPROVED,
      isEmailVerified: false,
      businessAddress: contact.address ?? null,
    });

    const saved = await this.usersRepository.save(buyer);
    this.logger.log(`Created buyer ${saved.id} from chat`);
    return { buyerId: saved.id };
  }

  /** Fill in what is missing without clobbering what is already known. */
  private async fillGaps(buyer: User, contact: BuyerContact): Promise<string> {
    let dirty = false;

    if (contact.email && buyer.email.endsWith(SYNTHETIC_EMAIL_DOMAIN)) {
      buyer.email = contact.email;
      dirty = true;
    }
    if (contact.address && !buyer.businessAddress) {
      buyer.businessAddress = contact.address;
      dirty = true;
    }

    if (dirty) await this.usersRepository.save(buyer);
    return buyer.id;
  }
}

/**
 * `users.email` is NOT NULL UNIQUE and most buyers give only a phone. A synthetic,
 * non-routable address satisfies the constraint; the `@buyers.` domain makes these rows
 * obvious, and a real address overwrites it later.
 */
function syntheticEmail(phoneE164: string): string {
  return `${phoneE164.replace('+', '')}${SYNTHETIC_EMAIL_DOMAIN}`;
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Buyer', lastName: '-' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '-' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/** "Amaka O." — first name and an initial, enough to tell colleagues apart. */
function staffName(user: Pick<User, 'firstName' | 'lastName'>): string {
  const first = user.firstName?.trim() || 'Staff';
  const initial = user.lastName?.trim().charAt(0);
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
}
