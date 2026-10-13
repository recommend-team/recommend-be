import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Human takeover of a conversation.
 *
 * `chat_messages.adminId` deliberately does not change `author`. The buyer must not be
 * able to tell a person answered, so the message stays `ASSISTANT` and attribution lives
 * in a column nothing buyer-facing reads.
 *
 * No foreign keys to `users`, matching the other audit-ish columns here: a transcript has
 * to survive the deletion of the admin who typed into it.
 */
export class AdminChatHandover1786021000000 implements MigrationInterface {
  name = 'AdminChatHandover1786021000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversations"
        ADD COLUMN "heldByAdminId" uuid,
        ADD COLUMN "heldAt" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "lastAdminMessageAt" TIMESTAMP WITH TIME ZONE
    `);

    // Partial: the queue only ever asks which conversations are held, and held ones are
    // the rare case.
    await queryRunner.query(`
      CREATE INDEX "IDX_conversations_held"
        ON "conversations" ("heldByAdminId") WHERE "heldByAdminId" IS NOT NULL
    `);

    await queryRunner.query(
      `ALTER TABLE "chat_messages" ADD COLUMN "adminId" uuid`,
    );
    await queryRunner.query(`
      CREATE INDEX "IDX_chat_messages_admin"
        ON "chat_messages" ("adminId") WHERE "adminId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_chat_messages_admin"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "adminId"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_conversations_held"`,
    );
    await queryRunner.query(`
      ALTER TABLE "conversations"
        DROP COLUMN IF EXISTS "lastAdminMessageAt",
        DROP COLUMN IF EXISTS "heldAt",
        DROP COLUMN IF EXISTS "heldByAdminId"
    `);
  }
}
