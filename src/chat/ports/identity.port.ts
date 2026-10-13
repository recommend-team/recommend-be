export const IDENTITY_PORT = Symbol('IDENTITY_PORT');

export interface BuyerContact {
  name: string;
  /** E.164. */
  phone: string;
  email?: string;
  address?: string;
}

export interface IdentityPort {
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
