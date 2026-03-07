import { MigrationInterface, QueryRunner } from 'typeorm';

export class RolesAndKycExpansion1770060000000 implements MigrationInterface {
  name = 'RolesAndKycExpansion1770060000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Extend the users_role_enum to include RIDER and BUYER ────────────
    await queryRunner.query(`
      ALTER TYPE "public"."users_role_enum"
      ADD VALUE IF NOT EXISTS 'RIDER'
    `);
    await queryRunner.query(`
      ALTER TYPE "public"."users_role_enum"
      ADD VALUE IF NOT EXISTS 'BUYER'
    `);

    // ── 2. Create vendor_type enum ───────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."vendor_type_enum" AS ENUM ('REGISTERED', 'NON_REGISTERED');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // ── 3. Create rider_type enum ────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."rider_type_enum" AS ENUM ('INDIVIDUAL', 'COMPANY');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // ── 4. Make phoneNumber nullable on users (buyers may not have one) ──────
    await queryRunner.query(`
      ALTER TABLE "users"
      ALTER COLUMN "phoneNumber" DROP NOT NULL
    `);

    // ── 5. Add vendor-specific columns to users ──────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "vendorType" "public"."vendor_type_enum" NULL,
      ADD COLUMN IF NOT EXISTS "orderQuota" integer NULL,
      ADD COLUMN IF NOT EXISTS "monthlyOrderCount" integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "lastOrderCountReset" timestamptz NULL
    `);

    // ── 6. Add rider-specific columns to users ───────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "riderType" "public"."rider_type_enum" NULL
    `);

    // ── 7. Add KYC document URL columns (registered vendor) ─────────────────
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "cacDocumentUrl" varchar NULL,
      ADD COLUMN IF NOT EXISTS "tinDocumentUrl" varchar NULL
    `);

    // ── 8. Add KYC document URL columns (non-registered vendor) ─────────────
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "ninDocumentUrl" varchar NULL,
      ADD COLUMN IF NOT EXISTS "passportPhotoUrl" varchar NULL,
      ADD COLUMN IF NOT EXISTS "bankStatementUrl" varchar NULL,
      ADD COLUMN IF NOT EXISTS "utilityBillUrl" varchar NULL
    `);

    // ── 9. Add KYC document URL columns (rider) ──────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "governmentIdUrl" varchar NULL,
      ADD COLUMN IF NOT EXISTS "selfieUrl" varchar NULL,
      ADD COLUMN IF NOT EXISTS "bvn" varchar NULL,
      ADD COLUMN IF NOT EXISTS "guarantorName" varchar NULL,
      ADD COLUMN IF NOT EXISTS "guarantorPhone" varchar NULL
    `);

    // ── 10. Extend the pending_users table ───────────────────────────────────
    //   Add role, vendorType, riderType; make phoneNumber nullable
    await queryRunner.query(`
      ALTER TABLE "pending_users"
      ALTER COLUMN "phoneNumber" DROP NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "pending_users"
      ADD COLUMN IF NOT EXISTS "role" "public"."users_role_enum" NOT NULL DEFAULT 'SELLER',
      ADD COLUMN IF NOT EXISTS "vendorType" "public"."vendor_type_enum" NULL,
      ADD COLUMN IF NOT EXISTS "riderType" "public"."rider_type_enum" NULL
    `);

    // ── 11. Fix timestamp columns to use timestamptz consistently ────────────
    await queryRunner.query(`
      ALTER TABLE "users"
      ALTER COLUMN "emailVerifiedAt" TYPE timestamptz USING "emailVerifiedAt"::timestamptz,
      ALTER COLUMN "lastLoginAt" TYPE timestamptz USING "lastLoginAt"::timestamptz,
      ALTER COLUMN "passwordChangedAt" TYPE timestamptz USING "passwordChangedAt"::timestamptz,
      ALTER COLUMN "emailVerificationTokenExpires" TYPE timestamptz USING "emailVerificationTokenExpires"::timestamptz,
      ALTER COLUMN "passwordResetTokenExpires" TYPE timestamptz USING "passwordResetTokenExpires"::timestamptz
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rider KYC columns
    await queryRunner.query(`
      ALTER TABLE "users"
      DROP COLUMN IF EXISTS "governmentIdUrl",
      DROP COLUMN IF EXISTS "selfieUrl",
      DROP COLUMN IF EXISTS "bvn",
      DROP COLUMN IF EXISTS "guarantorName",
      DROP COLUMN IF EXISTS "guarantorPhone"
    `);

    // Non-registered vendor KYC columns
    await queryRunner.query(`
      ALTER TABLE "users"
      DROP COLUMN IF EXISTS "ninDocumentUrl",
      DROP COLUMN IF EXISTS "passportPhotoUrl",
      DROP COLUMN IF EXISTS "bankStatementUrl",
      DROP COLUMN IF EXISTS "utilityBillUrl"
    `);

    // Registered vendor KYC columns
    await queryRunner.query(`
      ALTER TABLE "users"
      DROP COLUMN IF EXISTS "cacDocumentUrl",
      DROP COLUMN IF EXISTS "tinDocumentUrl"
    `);

    // Rider type
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "riderType"`,
    );

    // Vendor columns
    await queryRunner.query(`
      ALTER TABLE "users"
      DROP COLUMN IF EXISTS "vendorType",
      DROP COLUMN IF EXISTS "orderQuota",
      DROP COLUMN IF EXISTS "monthlyOrderCount",
      DROP COLUMN IF EXISTS "lastOrderCountReset"
    `);

    // Pending users rollback
    await queryRunner.query(`
      ALTER TABLE "pending_users"
      DROP COLUMN IF EXISTS "role",
      DROP COLUMN IF EXISTS "vendorType",
      DROP COLUMN IF EXISTS "riderType"
    `);
    await queryRunner.query(`
      ALTER TABLE "pending_users"
      ALTER COLUMN "phoneNumber" SET NOT NULL
    `);

    // Restore phoneNumber NOT NULL on users
    await queryRunner.query(`
      ALTER TABLE "users"
      ALTER COLUMN "phoneNumber" SET NOT NULL
    `);

    // Note: PostgreSQL does not support DROP VALUE from enum types
    // RIDER and BUYER values will remain in users_role_enum
  }
}
