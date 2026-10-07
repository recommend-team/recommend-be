import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Buyer devices that can receive web push (NOTIFICATIONS_PLAN.md, N4).
 *
 * Keyed to the conversation — buyers have no account. Deleted with it: a device with no
 * conversation behind it has nothing left to be told.
 */
export class BuyerPushSubscriptions1786026000000 implements MigrationInterface {
  name = 'BuyerPushSubscriptions1786026000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "buyer_push_subscriptions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "conversationId" uuid NOT NULL,
        "endpoint" character varying NOT NULL,
        "keys" jsonb NOT NULL,
        "userAgent" character varying,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_buyer_push_subscriptions_endpoint" UNIQUE ("endpoint"),
        CONSTRAINT "PK_buyer_push_subscriptions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_buyer_push_subscriptions_conversation"
          FOREIGN KEY ("conversationId") REFERENCES "conversations"("id")
          ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_buyer_push_subscriptions_conversation"
        ON "buyer_push_subscriptions" ("conversationId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "buyer_push_subscriptions"`);
  }
}
