import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Admins delete conversations (soft: `deletedAt`), and who did it is kept. The one-live-
 * conversation-per-account rule now ignores deleted ones, so a buyer whose chat was
 * deleted gets a fresh one when they next sign in. And the launch waitlist, filled while
 * the chat is paused.
 */
export class ConversationDeletion1786042000000 implements MigrationInterface {
  name = 'ConversationDeletion1786042000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "deletedByAdminId" uuid`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_conversations_live_account"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_conversations_live_account"
        ON "conversations" ("accountId")
        WHERE "accountId" IS NOT NULL AND "mergedIntoId" IS NULL AND "deletedAt" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "waitlist_signups" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "contact" character varying(200) NOT NULL,
        "kind" character varying(10) NOT NULL,
        "conversationId" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_waitlist_signups" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_waitlist_signups_contact" UNIQUE ("contact")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "waitlist_signups"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_conversations_live_account"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_conversations_live_account"
        ON "conversations" ("accountId")
        WHERE "accountId" IS NOT NULL AND "mergedIntoId" IS NULL
    `);
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN IF EXISTS "deletedByAdminId"`,
    );
  }
}
