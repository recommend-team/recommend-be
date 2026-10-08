import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The checkout's receipt-email step: "Where should we send your receipt?", asked after
 * the phone number. Optional — a buyer can skip it, and a signed-in one is never asked.
 */
export class ReceiptEmailStep1786030000000 implements MigrationInterface {
  name = 'ReceiptEmailStep1786030000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."conversations_state_enum" ADD VALUE IF NOT EXISTS 'COLLECTING_EMAIL' AFTER 'COLLECTING_PHONE'`,
    );
  }

  /**
   * Postgres cannot drop an enum value. Anyone mid-step moves on to the next one, and the
   * unused value stays — harmless, and re-running `up` is a no-op.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "conversations" SET "state" = 'COLLECTING_FULFILLMENT' WHERE "state" = 'COLLECTING_EMAIL'`,
    );
  }
}
