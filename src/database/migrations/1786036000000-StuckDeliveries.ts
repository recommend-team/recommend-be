import { MigrationInterface, QueryRunner } from 'typeorm';

export class StuckDeliveries1786036000000 implements MigrationInterface {
  name = 'StuckDeliveries1786036000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."notifications_type_enum" ADD VALUE IF NOT EXISTS 'ADMIN_DELIVERY_STUCK'`,
    );
    await queryRunner.query(
      `ALTER TABLE "checkouts" ADD COLUMN IF NOT EXISTS "stuckAlertedAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "notifications" WHERE "type"::text = 'ADMIN_DELIVERY_STUCK'`,
    );
    await queryRunner.query(
      `ALTER TABLE "checkouts" DROP COLUMN IF EXISTS "stuckAlertedAt"`,
    );
  }
}
