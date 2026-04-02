export enum Role {
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMIN = 'ADMIN',
  SELLER = 'SELLER',
  RIDER = 'RIDER',
  BUYER = 'BUYER',
}

/**
 * Defines which roles each role can act as (permission inheritance).
 * SUPER_ADMIN > ADMIN > SELLER / RIDER
 * BUYER is isolated — managed by the WhatsApp bot, not admin-inheritable.
 */
export const RoleHierarchy: Record<Role, Role[]> = {
  [Role.SUPER_ADMIN]: [Role.SUPER_ADMIN, Role.ADMIN, Role.SELLER, Role.RIDER],
  [Role.ADMIN]: [Role.ADMIN, Role.SELLER, Role.RIDER],
  [Role.SELLER]: [Role.SELLER],
  [Role.RIDER]: [Role.RIDER],
  [Role.BUYER]: [Role.BUYER],
};
