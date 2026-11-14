import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chat messages that carry someone's details — the name, phone, email and address given
 * at checkout, the order read back, the delivery code — are marked, and never sent to
 * the AI model as history.
 *
 * Existing rows are marked as well as can be told after the fact: the order read-back
 * and delivery-code messages by their wording, and a buyer's reply by the checkout
 * question just before it.
 */
export class PersonalMessages1786043000000 implements MigrationInterface {
  name = 'PersonalMessages1786043000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "personal" boolean NOT NULL DEFAULT false`,
    );

    // The order read back, and anything that gives out a delivery code.
    await queryRunner.query(`
      UPDATE "chat_messages" SET "personal" = true
      WHERE "payload"->>'kind' IN ('order_summary', 'payment_link')
         OR "text" ILIKE '%delivery code is%'
         OR "text" ILIKE '%Show the code%'
    `);

    // A buyer's answer to a checkout question: their name, number, email or address.
    await queryRunner.query(`
      UPDATE "chat_messages" m SET "personal" = true
      FROM (
        SELECT "id", "direction",
               LAG("text") OVER (PARTITION BY "conversationId" ORDER BY "createdAt") AS "asked"
        FROM "chat_messages"
      ) p
      WHERE m."id" = p."id"
        AND p."direction" = 'INBOUND'
        AND p."asked" ~* '(what name should|what number can we reach|send your receipt|email in below|delivery address|house or flat number|new address|bit more of the address|landmark|which area is that in)'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "personal"`,
    );
  }
}
