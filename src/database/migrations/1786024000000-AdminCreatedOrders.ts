import { MigrationInterface, QueryRunner } from 'typeorm';

export class AdminCreatedOrders1786024000000 implements MigrationInterface {
  name = 'AdminCreatedOrders1786024000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "checkouts"
        ADD COLUMN "createdByAdminId" uuid
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "checkouts"
        DROP COLUMN IF EXISTS "createdByAdminId"
    `);
  }
}
