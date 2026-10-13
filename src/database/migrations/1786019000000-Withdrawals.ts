import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Withdrawals.
 *
 * `reference` is unique because it is what Paystack deduplicates on. Every retry sends
 * the same one, so the constraint is not tidiness — it is the guarantee that a retry
 * cannot become a second payment.
 */
export class Withdrawals1786019000000 implements MigrationInterface {
  name = 'Withdrawals1786019000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."withdrawals_status_enum" AS ENUM(
        'REQUESTED', 'PROCESSING', 'SETTLED', 'FAILED', 'REVERSED'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "withdrawals" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "accountId" uuid NOT NULL,
        "amountRequested" numeric(14,2) NOT NULL,
        "feeAmount" numeric(14,2) NOT NULL DEFAULT 0,
        "amountSent" numeric(14,2) NOT NULL,
        "status" "public"."withdrawals_status_enum" NOT NULL DEFAULT 'REQUESTED',
        "reference" character varying NOT NULL,
        "recipientCode" character varying NOT NULL,
        "transferCode" character varying,
        "failureReason" text,
        "attempts" integer NOT NULL DEFAULT 0,
        "lastAttemptAt" TIMESTAMP WITH TIME ZONE,
        "settledAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_withdrawals" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_withdrawals_reference" UNIQUE ("reference")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_withdrawals_user" ON "withdrawals" ("userId")`,
    );
    // The retry sweep: everything PROCESSING, oldest attempt first.
    await queryRunner.query(
      `CREATE INDEX "IDX_withdrawals_status_attempt" ON "withdrawals" ("status", "lastAttemptAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_withdrawals_status_attempt"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_withdrawals_user"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "withdrawals"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."withdrawals_status_enum"`,
    );
  }
}
