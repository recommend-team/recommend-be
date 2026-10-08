import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Buyers who sign in with a verified email, so their chat follows them across browsers.
 *
 * - `chat_accounts`: one row per verified email.
 * - `conversations.accountId`: the conversation an account owns. Partial unique — one
 *   live conversation per account; merged ones are excluded.
 * - `conversations.mergedIntoId`: where a conversation went when it was folded into the
 *   account's own on sign-in.
 */
export class ChatAccounts1786029000000 implements MigrationInterface {
  name = 'ChatAccounts1786029000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "chat_accounts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "email" character varying NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "lastSignedInAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "UQ_chat_accounts_email" UNIQUE ("email"),
        CONSTRAINT "PK_chat_accounts" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "accountId" uuid, ADD "mergedIntoId" uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "conversations"
        ADD CONSTRAINT "FK_conversations_account"
        FOREIGN KEY ("accountId") REFERENCES "chat_accounts"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "conversations"
        ADD CONSTRAINT "FK_conversations_merged_into"
        FOREIGN KEY ("mergedIntoId") REFERENCES "conversations"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_conversations_account" ON "conversations" ("accountId")`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_conversations_live_account"
        ON "conversations" ("accountId")
        WHERE "accountId" IS NOT NULL AND "mergedIntoId" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_conversations_live_account"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_conversations_account"`);
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "FK_conversations_merged_into"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "FK_conversations_account"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN IF EXISTS "mergedIntoId", DROP COLUMN IF EXISTS "accountId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "chat_accounts"`);
  }
}
