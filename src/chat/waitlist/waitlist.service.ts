import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { toE164 } from '../utils/phone.util';
import { WaitlistContactKind, WaitlistSignup } from './waitlist-signup.entity';

export interface WaitlistContact {
  kind: WaitlistContactKind;
  /** E.164 for a phone, lower-cased for an email. */
  contact: string;
}

const EMAIL = /[^\s@<>()"',;:]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i;

/**
 * A Nigerian mobile number, however it is typed: "0803 123 4567", "+234-803-123-4567",
 * "2348031234567". Mobile numbers only — they start 7, 8 or 9 after the trunk prefix.
 */
const PHONE = /(?:\+?\s*234|0)[\s-]*[789][\s-]*[01](?:[\s-]*\d){8}(?!\d)/;

/**
 * The phone number or email in a message, if there is one — "my number is 0803 123
 * 4567", "ada@example.com". An email wins if both are given, being the less ambiguous.
 */
export function contactIn(text: string): WaitlistContact | null {
  const email = EMAIL.exec(text)?.[0];
  if (email) return { kind: 'EMAIL', contact: email.toLowerCase() };

  const phone = PHONE.exec(text)?.[0];
  const e164 = phone ? toE164(phone) : null;
  return e164 ? { kind: 'PHONE', contact: e164 } : null;
}

/**
 * The people waiting for ordering to open. Filled from the paused chat; read by admins,
 * who tell everyone at launch.
 */
@Injectable()
export class WaitlistService {
  constructor(
    @InjectRepository(WaitlistSignup)
    private readonly signups: Repository<WaitlistSignup>,
  ) {}

  /** Adds them, once. `joined` is false when the contact was already on the list. */
  async join(
    contact: WaitlistContact,
    conversationId: string | null,
  ): Promise<{ joined: boolean }> {
    const result = await this.signups
      .createQueryBuilder()
      .insert()
      .into(WaitlistSignup)
      .values({ ...contact, conversationId })
      .orIgnore()
      .execute();
    // ON CONFLICT DO NOTHING returns no row for a contact already on the list.
    return { joined: Array.isArray(result.raw) && result.raw.length > 0 };
  }

  /** Newest first. */
  async list(query: { page?: number; limit?: number }): Promise<{
    items: WaitlistSignup[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const [items, total] = await this.signups.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, total, page, limit };
  }

  /** Everyone, oldest first — the order they joined in — as CSV for a spreadsheet. */
  async csv(): Promise<string> {
    const all = await this.signups.find({ order: { createdAt: 'ASC' } });
    const rows = all.map((signup) =>
      [signup.kind, signup.contact, signup.createdAt.toISOString()]
        .map(csvCell)
        .join(','),
    );
    return ['kind,contact,joinedAt', ...rows].join('\r\n') + '\r\n';
  }
}

/** Quoted when needed, and never read as a formula by a spreadsheet. */
function csvCell(value: string): string {
  const safe =
    /^[=+\-@]/.test(value) && !/^\+\d+$/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
