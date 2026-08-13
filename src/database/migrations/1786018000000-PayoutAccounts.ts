import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payout accounts, moved off `users`.
 *
 * The four bank columns on `users` were written by `PATCH /sellers/profile/payout` and
 * read by nothing. Each vendor who filled them in gets a row here — but as
 * `PENDING_VERIFICATION`, not active: those details were never resolved against Paystack
 * and the account name is whatever the vendor typed. Importing them as verified would be
 * a lie with money attached.
 *
 * The old columns stay for now. Dropping them belongs with the rest of the cleanup, once
 * this migration has been proven against production data.
 */
export class PayoutAccounts1786018000000 implements MigrationInterface {
  name = 'PayoutAccounts1786018000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."accounts_status_enum" AS ENUM(
        'PENDING_VERIFICATION', 'ACTIVE', 'REMOVED'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "accounts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "bankName" character varying NOT NULL,
        "bankCode" character varying NOT NULL,
        "accountNumber" character varying(10) NOT NULL,
        "accountName" character varying NOT NULL,
        "paystackRecipientCode" character varying,
        "status" "public"."accounts_status_enum" NOT NULL DEFAULT 'PENDING_VERIFICATION',
        "isDefault" boolean NOT NULL DEFAULT false,
        "verificationCodeHash" character varying,
        "verificationExpiresAt" TIMESTAMP WITH TIME ZONE,
        "verificationAttempts" integer NOT NULL DEFAULT 0,
        "lastCodeSentAt" TIMESTAMP WITH TIME ZONE,
        "verifiedAt" TIMESTAMP WITH TIME ZONE,
        "removedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_accounts" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_accounts_user" ON "accounts" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_accounts_user_status" ON "accounts" ("userId", "status")`,
    );

    // One default per user, enforced by the database rather than by remembering to clear
    // the old one first.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_accounts_one_default_per_user"
        ON "accounts" ("userId") WHERE "isDefault" = true
    `);

    // The same account cannot be added twice while it is still live.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_accounts_live_per_user"
        ON "accounts" ("userId", "bankCode", "accountNumber")
        WHERE "status" <> 'REMOVED'
    `);

    await queryRunner.query(`
      INSERT INTO "accounts"
        ("userId", "bankName", "bankCode", "accountNumber", "accountName", "status")
      SELECT
        "id",
        COALESCE("bankName", 'Unknown bank'),
        COALESCE("bankCode", ''),
        "bankAccountNumber",
        COALESCE("bankAccountName", ''),
        'PENDING_VERIFICATION'
      FROM "users"
      WHERE "bankAccountNumber" IS NOT NULL
        AND "bankAccountNumber" <> ''
        AND char_length("bankAccountNumber") = 10
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_accounts_live_per_user"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_accounts_one_default_per_user"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_accounts_user_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_accounts_user"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "accounts"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."accounts_status_enum"`,
    );
  }
}
