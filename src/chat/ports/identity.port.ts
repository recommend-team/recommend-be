import type { Role } from '../../common/enums/roles.enum';

export const IDENTITY_PORT = Symbol('IDENTITY_PORT');

export interface BuyerContact {
  name: string;
  /** E.164. */
  phone: string;
  email?: string;
  address?: string;
}

/** Someone working the admin panel — an admin, or customer service. */
export interface StaffMember {
  id: string;
  role: Role;
  /** "Amaka O." — how colleagues see who is handling a chat. Never shown to buyers. */
  name: string;
}

export interface IdentityPort {
  /**
   * The staff member behind this id, read fresh — null when it is not a staff account, or
   * one that may not sign in any more (suspended, deactivated). A login token can be
   * days old; this is what it says *now*.
   */
  staffMember(id: string): Promise<StaffMember | null>;

  /** Display names for these staff ids. Ids that are not staff are left out. */
  staffNames(ids: string[]): Promise<Map<string, string>>;

  /** Every admin and agent who can sign in now, by name. */
  listStaff(): Promise<StaffMember[]>;

  /**
   * Find or create the buyer record behind this contact, matching on phone.
   *
   * The details are UNVERIFIED. This must never be used to grant access to anything —
   * only to give orders something durable to hang off and somewhere to send updates.
   * A later WhatsApp identity, whose number Meta has verified, is authoritative over
   * anything written here.
   */
  upsertBuyer(contact: BuyerContact): Promise<{ buyerId: string }>;
}
