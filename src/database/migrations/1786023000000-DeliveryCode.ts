import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The code a customer reads out at the door.
 *
 * Nullable with no default and no backfill: `NULL` means "not dispatched", which is true
 * of every checkout that exists today and permanently true of pickup, unpaid and
 * cancelled ones.
 */
export class DeliveryCode1786023000000 implements MigrationInterface {
  name = 'DeliveryCode1786023000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "checkouts"
        ADD COLUMN "deliveryCode" character varying(6)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "checkouts"
        DROP COLUMN IF EXISTS "deliveryCode"
    `);
  }
}
