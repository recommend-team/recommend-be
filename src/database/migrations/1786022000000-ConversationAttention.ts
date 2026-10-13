import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The triage signal.
 *
 * A timestamp rather than a boolean: the queue leads with the buyer who has been stuck
 * longest, which is a different ordering from "newest message". A flag would have to be
 * paired with one anyway.
 */
export class ConversationAttention1786022000000 implements MigrationInterface {
  name = 'ConversationAttention1786022000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversations"
        ADD COLUMN "needsAttentionAt" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "attentionReason" character varying
    `);

    // Partial, and oldest-first: the queue only ever asks for the flagged ones, and they
    // are the small minority.
    await queryRunner.query(`
      CREATE INDEX "IDX_conversations_attention"
        ON "conversations" ("needsAttentionAt" ASC)
        WHERE "needsAttentionAt" IS NOT NULL
    `);

    // The default ordering for everything else.
    await queryRunner.query(`
      CREATE INDEX "IDX_conversations_last_message"
        ON "conversations" ("lastMessageAt" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_conversations_last_message"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_conversations_attention"`,
    );
    await queryRunner.query(`
      ALTER TABLE "conversations"
        DROP COLUMN IF EXISTS "attentionReason",
        DROP COLUMN IF EXISTS "needsAttentionAt"
    `);
  }
}
