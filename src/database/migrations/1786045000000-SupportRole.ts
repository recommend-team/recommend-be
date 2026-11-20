import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer service agents: a `SUPPORT` role who answer buyers in the chat queue and
 * nothing else on the admin side. Added to both role enums — `pending_users` shares the
 * `Role` type, and the two must match the entity or the next generated migration would
 * try to "fix" them.
 */
export class SupportRole1786045000000 implements MigrationInterface {
  name = 'SupportRole1786045000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."users_role_enum" ADD VALUE IF NOT EXISTS 'SUPPORT'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."pending_users_role_enum" ADD VALUE IF NOT EXISTS 'SUPPORT'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres cannot drop a value from an enum, and leaving it is harmless once the code
    // that writes it is rolled back. Agents are deactivated, so nobody keeps signing in
    // with a role the older code does not know.
    await queryRunner.query(
      `UPDATE "users" SET "status" = 'DEACTIVATED' WHERE "role" = 'SUPPORT'`,
    );
  }
}
