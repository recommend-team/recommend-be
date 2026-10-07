import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Admin alerts, kept in the notifications feed so the admin panel has a bell.
 *
 * Appended, as `WalletNotifications` did: nothing sorts on this enum. `down()` cannot
 * remove them — dropping a Postgres enum value means rebuilding the type — so it removes
 * the rows instead, leaving the labels unused.
 */
export class AdminNotifications1786027000000 implements MigrationInterface {
  name = 'AdminNotifications1786027000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of ADMIN_TYPES) {
      await queryRunner.query(
        `ALTER TYPE "public"."notifications_type_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "notifications" WHERE "type"::text LIKE 'ADMIN\\_%'`,
    );
  }
}

const ADMIN_TYPES = [
  'ADMIN_CONVERSATION_HANDED_OVER',
  'ADMIN_CONVERSATION_FLAGGED',
  'ADMIN_HELD_CONVERSATION_MESSAGE',
  'ADMIN_NEW_PAID_ORDER',
  'ADMIN_VENDOR_ORDER_READY',
  'ADMIN_WITHDRAWAL_FAILED',
];
