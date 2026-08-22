import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chat foundation — conversations and their messages.
 *
 * `channelAddress` is the channel-native identity of a device or number: for the PWA
 * it is the session id from the device's token, for WhatsApp it will be the E.164
 * number. The unique index on (channel, channelAddress) is what makes a returning
 * device reconnect into its existing thread instead of opening a new one.
 */
export class ChatFoundation1786013000000 implements MigrationInterface {
  name = 'ChatFoundation1786013000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."conversations_channel_enum" AS ENUM('PWA', 'WHATSAPP')
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."conversations_state_enum" AS ENUM(
        'DISCOVERY', 'SELECTING_ITEM', 'COLLECTING_NAME', 'COLLECTING_PHONE',
        'COLLECTING_FULFILLMENT', 'COLLECTING_ADDRESS', 'CONFIRMING_ORDER',
        'AWAITING_PAYMENT'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."chat_messages_direction_enum" AS ENUM('INBOUND', 'OUTBOUND')
    `);
    await queryRunner.query(`
      CREATE TYPE "public"."chat_messages_author_enum" AS ENUM('BUYER', 'ASSISTANT', 'SYSTEM')
    `);

    await queryRunner.query(`
      CREATE TABLE "conversations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt" TIMESTAMP WITH TIME ZONE,
        "channel" "public"."conversations_channel_enum" NOT NULL,
        "channelAddress" character varying NOT NULL,
        "buyerId" uuid,
        "areaId" uuid,
        "state" "public"."conversations_state_enum" NOT NULL DEFAULT 'DISCOVERY',
        "context" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "lastMessageAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_conversations" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_conversations_channel" ON "conversations" ("channel")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conversations_buyerId" ON "conversations" ("buyerId")`,
    );
    // One live thread per device. Partial so soft-deleted rows do not block a re-open.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_conversations_channel_address"
      ON "conversations" ("channel", "channelAddress")
      WHERE "deletedAt" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "chat_messages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deletedAt" TIMESTAMP WITH TIME ZONE,
        "conversationId" uuid NOT NULL,
        "direction" "public"."chat_messages_direction_enum" NOT NULL,
        "author" "public"."chat_messages_author_enum" NOT NULL,
        "text" text NOT NULL,
        "payload" jsonb,
        "channelMessageId" character varying,
        "clientMessageId" character varying,
        CONSTRAINT "PK_chat_messages" PRIMARY KEY ("id"),
        CONSTRAINT "FK_chat_messages_conversation" FOREIGN KEY ("conversationId")
          REFERENCES "conversations"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_chat_messages_conversationId" ON "chat_messages" ("conversationId")`,
    );
    // History pages are ordered by createdAt within a conversation.
    await queryRunner.query(`
      CREATE INDEX "IDX_chat_messages_conversation_created"
      ON "chat_messages" ("conversationId", "createdAt" DESC)
    `);
    // Backs the de-duplication lookup for retried client sends.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_chat_messages_client_id"
      ON "chat_messages" ("conversationId", "clientMessageId")
      WHERE "clientMessageId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "chat_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "conversations"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."chat_messages_author_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."chat_messages_direction_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."conversations_state_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."conversations_channel_enum"`,
    );
  }
}
