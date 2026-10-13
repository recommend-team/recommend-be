import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConversationHandover1786025000000 implements MigrationInterface {
  name = 'ConversationHandover1786025000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversations"
        ADD COLUMN "handoverRequestedAt" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "handoverReason" character varying
    `);

    // Partial: at any moment a handful of conversations are waiting, out of all of them.
    await queryRunner.query(`
      CREATE INDEX "IDX_conversations_handover"
        ON "conversations" ("handoverRequestedAt" ASC)
        WHERE "handoverRequestedAt" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_conversations_handover"`,
    );
    await queryRunner.query(`
      ALTER TABLE "conversations"
        DROP COLUMN IF EXISTS "handoverReason",
        DROP COLUMN IF EXISTS "handoverRequestedAt"
    `);
  }
}
