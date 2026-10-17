import { SetMetadata } from '@nestjs/common';

export const ALLOW_WHEN_SUSPENDED_KEY = 'allowWhenSuspended';

/**
 * Lets a suspended vendor use an endpoint that changes something.
 *
 * A suspended vendor is read-only (`SuspendedReadOnlyGuard`): they can sign in and see
 * everything, but every write is refused — unless it carries this. Kept for what a
 * suspension must not get in the way of: signing out, clearing notifications, and
 * finishing orders buyers have already paid for.
 */
export const AllowWhenSuspended = () =>
  SetMetadata(ALLOW_WHEN_SUSPENDED_KEY, true);
