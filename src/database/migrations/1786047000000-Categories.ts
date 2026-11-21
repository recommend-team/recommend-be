import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Categories admins manage, each with what Recommend keeps of its sales, and a record of
 * every change to that. Orders now remember the percentage they were charged at.
 *
 * The table starts empty: the app fills it with the starting categories, at today's
 * rate, the first time it runs.
 */
export class Categories1786047000000 implements MigrationInterface {
  name = 'Categories1786047000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "categories" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt" TIMESTAMP WITH TIME ZONE,
        "name" character varying(60) NOT NULL,
        "feePercent" numeric(5,2) NOT NULL,
        "keywords" text array NOT NULL DEFAULT '{}',
        "isActive" boolean NOT NULL DEFAULT true,
        "createdByAdminId" uuid,
        CONSTRAINT "PK_categories_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_categories_fee_percent" CHECK ("feePercent" >= 0 AND "feePercent" <= 100)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_categories_name_lower" ON "categories" (lower("name"))`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "category_rate_changes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "categoryId" uuid NOT NULL,
        "previousPercent" numeric(5,2),
        "newPercent" numeric(5,2) NOT NULL,
        "changedByAdminId" uuid,
        CONSTRAINT "PK_category_rate_changes_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_category_rate_changes_category" FOREIGN KEY ("categoryId")
          REFERENCES "categories"("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_category_rate_changes_category_created" ON "category_rate_changes" ("categoryId", "createdAt")`,
    );

    // What each order was charged at. Older orders are worked out from what they
    // already recorded, so every order answers the same question.
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "feePercent" numeric(5,2)`,
    );
    await queryRunner.query(`
      UPDATE "orders"
         SET "feePercent" = ROUND("platformFee" / "totalAmount" * 100, 2)
       WHERE "feePercent" IS NULL AND "totalAmount" > 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "feePercent"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "category_rate_changes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "categories"`);
  }
}
