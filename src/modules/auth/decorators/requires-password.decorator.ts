import { SetMetadata } from '@nestjs/common';

export const REQUIRES_PASSWORD_KEY = 'requiresPassword';

/**
 * Re-authenticate before this action, even though the caller already holds a valid token.
 *
 * For anything that can move money to a new destination. A stolen session must not be
 * enough on its own, which is the same reason a bank asks again when you add a payee.
 */
export const RequiresPassword = () => SetMetadata(REQUIRES_PASSWORD_KEY, true);
