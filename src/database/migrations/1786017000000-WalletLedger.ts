import { MigrationInterface, QueryRunner } from 'typeorm';

export class WalletLedger1786017000000 implements MigrationInterface {
  name = 'WalletLedger1786017000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."wallet_entries_type_enum" AS ENUM(
        'EARNING', 'COMMISSION', 'WITHDRAWAL', 'WITHDRAWAL_REVERSED', 'ADJUSTMENT'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "wallet_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "type" "public"."wallet_entries_type_enum" NOT NULL,
        "amount" numeric(14,2) NOT NULL,
        "idempotencyKey" character varying NOT NULL,
        "orderId" uuid,
        "withdrawalId" uuid,
        "note" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wallet_entries" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_wallet_entries_idempotency_key" UNIQUE ("idempotencyKey")
      )
    `);

    // The statement query: one user's entries, newest first.
    await queryRunner.query(
      `CREATE INDEX "IDX_wallet_entries_user_created" ON "wallet_entries" ("userId", "createdAt" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_wallet_entries_order" ON "wallet_entries" ("orderId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_wallet_entries_withdrawal" ON "wallet_entries" ("withdrawalId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_wallet_entries_withdrawal"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_wallet_entries_order"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_wallet_entries_user_created"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "wallet_entries"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."wallet_entries_type_enum"`,
    );
  }
}
