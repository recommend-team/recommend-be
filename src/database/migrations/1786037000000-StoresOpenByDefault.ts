import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * New stores start open; a vendor closes theirs from the vendor app.
 *
 * Only the default changes. Existing stores keep whatever they are now — a closed one may
 * have been closed on purpose, and nothing records which.
 */
export class StoresOpenByDefault1786037000000 implements MigrationInterface {
  name = 'StoresOpenByDefault1786037000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "isOpen" SET DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "isOpen" SET DEFAULT false`,
    );
  }
}
