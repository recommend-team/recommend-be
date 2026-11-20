export enum Role {
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMIN = 'ADMIN',
  /**
   * Customer service: answers buyers in the chat queue, and nothing else on the admin
   * side — no KYC, vendors, wallets, areas or account management.
   */
  SUPPORT = 'SUPPORT',
  SELLER = 'SELLER',
  RIDER = 'RIDER',
  BUYER = 'BUYER',
}

/**
 * Defines which roles each role can act as (permission inheritance).
 * SUPER_ADMIN > ADMIN > SUPPORT, SELLER / RIDER
 * SUPPORT inherits nothing: an agent is never an admin, vendor or rider.
 * BUYER is isolated — managed by the WhatsApp bot, not admin-inheritable.
 */
export const RoleHierarchy: Record<Role, Role[]> = {
  [Role.SUPER_ADMIN]: [
    Role.SUPER_ADMIN,
    Role.ADMIN,
    Role.SUPPORT,
    Role.SELLER,
    Role.RIDER,
  ],
  [Role.ADMIN]: [Role.ADMIN, Role.SUPPORT, Role.SELLER, Role.RIDER],
  [Role.SUPPORT]: [Role.SUPPORT],
  [Role.SELLER]: [Role.SELLER],
  [Role.RIDER]: [Role.RIDER],
  [Role.BUYER]: [Role.BUYER],
};

/** Everyone who works the admin panel: the people a buyer's chat can reach. */
export const STAFF_ROLES: readonly Role[] = [
  Role.SUPER_ADMIN,
  Role.ADMIN,
  Role.SUPPORT,
];

/** Accounts a super admin creates and manages from the Admins page. */
export const MANAGED_STAFF_ROLES: readonly Role[] = [Role.ADMIN, Role.SUPPORT];
