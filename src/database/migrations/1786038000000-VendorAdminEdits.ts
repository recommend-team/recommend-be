import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Admins acting on vendors: a log of what they changed, and the notification that tells
 * the vendor.
 *
 * `down()` drops the table and the notification rows; the enum label stays (removing a
 * Postgres enum value means rebuilding the type — see `AdminNotifications`).
 */
export class VendorAdminEdits1786038000000 implements MigrationInterface {
  name = 'VendorAdminEdits1786038000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "vendor_admin_edits" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "vendorId" uuid NOT NULL,
        "adminId" uuid NOT NULL,
        "action" character varying(32) NOT NULL,
        "summary" text NOT NULL,
        "changes" jsonb,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vendor_admin_edits" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_vendor_admin_edits_vendor_created"
        ON "vendor_admin_edits" ("vendorId", "createdAt")
    `);
    await queryRunner.query(
      `ALTER TYPE "public"."notifications_type_enum" ADD VALUE IF NOT EXISTS 'STORE_UPDATED_BY_ADMIN'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "notifications" WHERE "type"::text = 'STORE_UPDATED_BY_ADMIN'`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "vendor_admin_edits"`);
  }
}
