import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Record where each checkout was placed: the chat, a vendor's storefront, or an admin.
 *
 * Storefront buyers may never open the chat, so the team needs to tell them apart to know
 * whom to call. Existing checkouts are chat orders, except those an admin placed, which
 * `createdByAdminId` already marks.
 */
export class CheckoutSource1786035000000 implements MigrationInterface {
  name = 'CheckoutSource1786035000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "checkouts"
        ADD "source" character varying(16) NOT NULL DEFAULT 'CHAT'
    `);
    await queryRunner.query(`
      UPDATE "checkouts" SET "source" = 'ADMIN' WHERE "createdByAdminId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "checkouts" DROP COLUMN "source"`);
  }
}
