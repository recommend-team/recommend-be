import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Keep a vendor's business details between sign-up and verification.
 *
 * The sign-up form collects them, but the pending row had nowhere to put them, so a
 * verified vendor started with no business name, category or store link — and could not
 * be found by buyers until they filled Store details in again.
 */
export class PendingVendorBusiness1786033000000 implements MigrationInterface {
  name = 'PendingVendorBusiness1786033000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "pending_users"
        ADD "businessName" character varying,
        ADD "businessAddress" character varying,
        ADD "businessCategory" character varying,
        ADD "businessDescription" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "pending_users"
        DROP COLUMN "businessDescription",
        DROP COLUMN "businessCategory",
        DROP COLUMN "businessAddress",
        DROP COLUMN "businessName"
    `);
  }
}
