import { SetMetadata } from '@nestjs/common';

export const APPROVED_ONLY_KEY = 'approvedOnly';

/**
 * Marks an endpoint as requiring an APPROVED account status.
 * Vendors/riders with PENDING KYC can still log in and access their
 * dashboard, but endpoints decorated with @ApprovedOnly() will reject
 * them until an admin approves their KYC.
 */
export const ApprovedOnly = () => SetMetadata(APPROVED_ONLY_KEY, true);
