import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wrong guesses at a sign-up's 6-digit email code are counted, so the code can't be
 * guessed: after five, the pending sign-up is cancelled and has to start again.
 */
export class SignupCodeAttempts1786044000000 implements MigrationInterface {
  name = 'SignupCodeAttempts1786044000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pending_users" ADD COLUMN IF NOT EXISTS "verificationAttempts" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pending_users" DROP COLUMN IF EXISTS "verificationAttempts"`,
    );
  }
}
