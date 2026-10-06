import { MigrationInterface, QueryRunner } from 'typeorm';

export class RiderAssignment1786028000000 implements MigrationInterface {
  name = 'RiderAssignment1786028000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "checkouts" ADD "riderId" uuid, ADD "riderAssignedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_checkouts_riderId" ON "checkouts" ("riderId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "checkouts" ADD CONSTRAINT "FK_checkouts_riderId" FOREIGN KEY ("riderId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(`ALTER TABLE "users" ADD "riderNote" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "riderNote"`);
    await queryRunner.query(
      `ALTER TABLE "checkouts" DROP CONSTRAINT "FK_checkouts_riderId"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_checkouts_riderId"`);
    await queryRunner.query(
      `ALTER TABLE "checkouts" DROP COLUMN "riderAssignedAt", DROP COLUMN "riderId"`,
    );
  }
}
