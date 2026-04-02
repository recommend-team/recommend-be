import { MigrationInterface, QueryRunner } from 'typeorm';

export class VendorProfileFields1770070000000 implements MigrationInterface {
  name = 'VendorProfileFields1770070000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Storefront visuals ───────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "businessLogoUrl" varchar NULL,
      ADD COLUMN IF NOT EXISTS "businessBannerUrl" varchar NULL,
      ADD COLUMN IF NOT EXISTS "whatsappNumber" varchar NULL,
      ADD COLUMN IF NOT EXISTS "isOpen" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "operatingHours" jsonb NULL
    `);

    // ── Payout / bank details ────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "bankName" varchar NULL,
      ADD COLUMN IF NOT EXISTS "bankCode" varchar NULL,
      ADD COLUMN IF NOT EXISTS "bankAccountNumber" varchar NULL,
      ADD COLUMN IF NOT EXISTS "bankAccountName" varchar NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      DROP COLUMN IF EXISTS "businessLogoUrl",
      DROP COLUMN IF EXISTS "businessBannerUrl",
      DROP COLUMN IF EXISTS "whatsappNumber",
      DROP COLUMN IF EXISTS "isOpen",
      DROP COLUMN IF EXISTS "operatingHours",
      DROP COLUMN IF EXISTS "bankName",
      DROP COLUMN IF EXISTS "bankCode",
      DROP COLUMN IF EXISTS "bankAccountNumber",
      DROP COLUMN IF EXISTS "bankAccountName"
    `);
  }
}
