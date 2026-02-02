import { MigrationInterface, QueryRunner } from 'typeorm';

export class SimplifySignup1770050183052 implements MigrationInterface {
  name = 'SimplifySignup1770050183052';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Remove duplicate phone numbers (keep only the first entry)
    await queryRunner.query(`
            DELETE FROM "users" WHERE "id" IN (
                SELECT "id" FROM (
                    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "phoneNumber" ORDER BY "createdAt") as rn
                    FROM "users"
                    WHERE "phoneNumber" IS NOT NULL
                ) tmp
                WHERE rn > 1
            )
        `);

    await queryRunner.query(
      `ALTER TABLE "pending_users" DROP COLUMN "businessName"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_users" DROP COLUMN "businessAddress"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_users" DROP COLUMN "businessDescription"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_users" DROP COLUMN "businessCategory"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_users" DROP COLUMN "businessAreas"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "firstName" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "lastName" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "phoneNumber" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "UQ_1e3d0240b49c40521aaeb953293" UNIQUE ("phoneNumber")`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_users" ALTER COLUMN "phoneNumber" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_users" ADD CONSTRAINT "UQ_6ed4e9d382ff1a74d4590178a6f" UNIQUE ("phoneNumber")`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_users" ALTER COLUMN "lastName" SET NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1e3d0240b49c40521aaeb95329" ON "users" ("phoneNumber") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_1e3d0240b49c40521aaeb95329"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_users" ALTER COLUMN "lastName" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_users" DROP CONSTRAINT "UQ_6ed4e9d382ff1a74d4590178a6f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_users" ALTER COLUMN "phoneNumber" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "UQ_1e3d0240b49c40521aaeb953293"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "phoneNumber" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "lastName" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "firstName" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_users" ADD "businessAreas" text array`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_users" ADD "businessCategory" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_users" ADD "businessDescription" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_users" ADD "businessAddress" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_users" ADD "businessName" character varying`,
    );
  }
}
