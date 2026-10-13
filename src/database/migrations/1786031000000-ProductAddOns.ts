import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add-ons (ADDONS_PLAN.md, sprint A1).
 *
 * - `products.isAddOn`: sold only with a main item from the same vendor.
 * - `OFFERING_ADDONS`: the checkout step that offers them, right after Pay.
 */
export class ProductAddOns1786031000000 implements MigrationInterface {
  name = 'ProductAddOns1786031000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "products" ADD "isAddOn" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_products_vendor_addon" ON "products" ("vendorId", "isAddOn")`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."conversations_state_enum" ADD VALUE IF NOT EXISTS 'OFFERING_ADDONS' BEFORE 'COLLECTING_NAME'`,
    );
  }

  /**
   * Postgres cannot drop an enum value. Anyone at the offer moves on to the details
   * step; the unused value stays, harmless.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "conversations" SET "state" = 'COLLECTING_NAME' WHERE "state" = 'OFFERING_ADDONS'`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_products_vendor_addon"`);
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "isAddOn"`);
  }
}
