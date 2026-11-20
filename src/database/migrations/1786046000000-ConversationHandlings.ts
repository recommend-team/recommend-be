import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Who answered each chat, and for how long: one row per spell of someone holding a
 * conversation. Feeds the conversation's history and the per-agent figures.
 */
export class ConversationHandlings1786046000000 implements MigrationInterface {
  name = 'ConversationHandlings1786046000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "conversation_handlings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "conversationId" uuid NOT NULL,
        "adminId" uuid NOT NULL,
        "waitingSince" TIMESTAMP WITH TIME ZONE,
        "takenAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "firstReplyAt" TIMESTAMP WITH TIME ZONE,
        "assignedByAdminId" uuid,
        "endedAt" TIMESTAMP WITH TIME ZONE,
        "endReason" character varying(32),
        "endedByAdminId" uuid,
        CONSTRAINT "PK_conversation_handlings_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_conversation_handlings_conversation_taken" ON "conversation_handlings" ("conversationId", "takenAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_conversation_handlings_admin_taken" ON "conversation_handlings" ("adminId", "takenAt")`,
    );
    // The bell entry an agent gets when an admin passes them a chat.
    await queryRunner.query(
      `ALTER TYPE "public"."notifications_type_enum" ADD VALUE IF NOT EXISTS 'ADMIN_CONVERSATION_ASSIGNED'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The enum value stays (Postgres cannot drop one); its rows go, so nothing reads it.
    await queryRunner.query(
      `DELETE FROM "notifications" WHERE "type"::text = 'ADMIN_CONVERSATION_ASSIGNED'`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "conversation_handlings"`);
  }
}
