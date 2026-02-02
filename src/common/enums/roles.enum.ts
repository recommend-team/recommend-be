export enum Role {
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMIN = 'ADMIN',
  SELLER = 'SELLER',
}

export const RoleHierarchy = {
  [Role.SUPER_ADMIN]: [Role.SUPER_ADMIN, Role.ADMIN, Role.SELLER],
  [Role.ADMIN]: [Role.ADMIN, Role.SELLER],
  [Role.SELLER]: [Role.SELLER],
};
