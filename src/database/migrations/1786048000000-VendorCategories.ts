import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vendors belong to a category by id, not only by what they typed, and the Super Admin
 * can give one vendor their own rate. The rate log records those too, and vendors get a
 * notification when what Recommend keeps of their sales goes up.
 *
 * Vendors are linked to categories by the app when it starts — the categories table is
 * filled then, so there is nothing to link to yet here.
 */
export class VendorCategories1786048000000 implements MigrationInterface {
  name = 'VendorCategories1786048000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "categoryId" uuid`,
    );
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "users" ADD CONSTRAINT "FK_users_category"
          FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_users_category" ON "users" ("categoryId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "customFeePercent" numeric(5,2)`,
    );
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "users" ADD CONSTRAINT "CHK_users_custom_fee_percent"
          CHECK ("customFeePercent" IS NULL OR ("customFeePercent" >= 0 AND "customFeePercent" <= 100));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

    // The log now covers one vendor's own rate as well as a category's. For a vendor,
    // a null new rate means their own rate was removed: back to their category's.
    await queryRunner.query(
      `ALTER TABLE "category_rate_changes" ALTER COLUMN "categoryId" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "category_rate_changes" ALTER COLUMN "newPercent" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "category_rate_changes" ADD COLUMN IF NOT EXISTS "vendorId" uuid`,
    );
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "category_rate_changes" ADD CONSTRAINT "CHK_category_rate_changes_subject"
          CHECK ("categoryId" IS NOT NULL OR "vendorId" IS NOT NULL);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_category_rate_changes_vendor_created" ON "category_rate_changes" ("vendorId", "createdAt")`,
    );

    await queryRunner.query(
      `ALTER TYPE "public"."notifications_type_enum" ADD VALUE IF NOT EXISTS 'COMMISSION_RATE_RAISED'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "notifications" WHERE "type"::text = 'COMMISSION_RATE_RAISED'`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_category_rate_changes_vendor_created"`,
    );
    await queryRunner.query(
      `ALTER TABLE "category_rate_changes" DROP CONSTRAINT IF EXISTS "CHK_category_rate_changes_subject"`,
    );
    await queryRunner.query(
      `DELETE FROM "category_rate_changes" WHERE "categoryId" IS NULL OR "newPercent" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "category_rate_changes" DROP COLUMN IF EXISTS "vendorId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "category_rate_changes" ALTER COLUMN "newPercent" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "category_rate_changes" ALTER COLUMN "categoryId" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "CHK_users_custom_fee_percent"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "customFeePercent"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_category"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "FK_users_category"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "categoryId"`,
    );
  }
}
