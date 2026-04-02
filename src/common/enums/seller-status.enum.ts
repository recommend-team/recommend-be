export enum SellerStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  SUSPENDED = 'SUSPENDED',
  DEACTIVATED = 'DEACTIVATED',
}

/** Semantic alias — use UserStatus for non-seller contexts */
export { SellerStatus as UserStatus };
