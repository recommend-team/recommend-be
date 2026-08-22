import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1786012633145 implements MigrationInterface {
  name = 'InitialSchema1786012633145';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Every table below defaults its id to uuid_generate_v4(), which lives in
    // this extension. A freshly provisioned database will not have it.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(
      `CREATE TABLE "states" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, "name" character varying(100) NOT NULL, "code" character varying(10), "isActive" boolean NOT NULL DEFAULT true, CONSTRAINT "UQ_fe52f02449eaf27be2b2cb7acda" UNIQUE ("name"), CONSTRAINT "UQ_b8af4194277281dcfe08be42643" UNIQUE ("code"), CONSTRAINT "PK_09ab30ca0975c02656483265f4f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fe52f02449eaf27be2b2cb7acd" ON "states" ("name") `,
    );
    await queryRunner.query(
      `CREATE TABLE "areas" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, "stateId" uuid NOT NULL, "name" character varying(100) NOT NULL, "isActive" boolean NOT NULL DEFAULT true, CONSTRAINT "UQ_area_state_name" UNIQUE ("stateId", "name"), CONSTRAINT "PK_5110493f6342f34c978c084d0d6" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1ca0b120621195acf138968a36" ON "areas" ("stateId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8c2ad80240e18fcac9e7c52631" ON "areas" ("name") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."users_role_enum" AS ENUM('SUPER_ADMIN', 'ADMIN', 'SELLER', 'RIDER', 'BUYER')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."users_status_enum" AS ENUM('PENDING', 'APPROVED', 'SUSPENDED', 'DEACTIVATED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."users_vendortype_enum" AS ENUM('REGISTERED', 'NON_REGISTERED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."users_ridertype_enum" AS ENUM('INDIVIDUAL', 'COMPANY')`,
    );
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, "email" character varying NOT NULL, "password" character varying, "firstName" character varying NOT NULL, "lastName" character varying NOT NULL, "phoneNumber" character varying, "role" "public"."users_role_enum" NOT NULL DEFAULT 'SELLER', "status" "public"."users_status_enum" NOT NULL DEFAULT 'PENDING', "vendorType" "public"."users_vendortype_enum", "slug" character varying, "businessName" character varying, "businessAddress" character varying, "businessDescription" text, "businessCategory" character varying, "orderQuota" integer, "monthlyOrderCount" integer NOT NULL DEFAULT '0', "lastOrderCountReset" TIMESTAMP WITH TIME ZONE, "riderType" "public"."users_ridertype_enum", "cacDocumentUrl" character varying, "tinDocumentUrl" character varying, "ninDocumentUrl" character varying, "passportPhotoUrl" character varying, "bankStatementUrl" character varying, "utilityBillUrl" character varying, "governmentIdUrl" character varying, "selfieUrl" character varying, "bvn" character varying, "guarantorName" character varying, "guarantorPhone" character varying, "businessLogoUrl" character varying, "businessBannerUrl" character varying, "whatsappNumber" character varying, "isOpen" boolean NOT NULL DEFAULT false, "operatingHours" jsonb, "bankName" character varying, "bankCode" character varying, "bankAccountNumber" character varying, "bankAccountName" character varying, "isEmailVerified" boolean NOT NULL DEFAULT false, "emailVerifiedAt" TIMESTAMP WITH TIME ZONE, "googleId" character varying, "profilePicture" character varying, "failedLoginAttempts" integer NOT NULL DEFAULT '0', "lastLoginAt" TIMESTAMP WITH TIME ZONE, "passwordChangedAt" TIMESTAMP WITH TIME ZONE, "emailVerificationToken" character varying, "emailVerificationTokenExpires" TIMESTAMP WITH TIME ZONE, "passwordResetToken" character varying, "passwordResetTokenExpires" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "UQ_1e3d0240b49c40521aaeb953293" UNIQUE ("phoneNumber"), CONSTRAINT "UQ_bc0c27d77ee64f0a097a5c269b3" UNIQUE ("slug"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_97672ac88f789774dd47f7c8be" ON "users" ("email") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1e3d0240b49c40521aaeb95329" ON "users" ("phoneNumber") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bc0c27d77ee64f0a097a5c269b" ON "users" ("slug") `,
    );
    await queryRunner.query(
      `CREATE TABLE "products" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "vendorId" uuid NOT NULL, "name" character varying(100) NOT NULL, "description" text, "price" numeric(10,2) NOT NULL, "imageUrl" character varying, "isAvailable" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0806c755e0aca124e67c0cf6d7d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."orders_fulfillmenttype_enum" AS ENUM('PICKUP', 'DELIVERY')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."orders_status_enum" AS ENUM('PENDING_PAYMENT', 'PAID', 'PROCESSING', 'COMPLETED', 'CANCELLED', 'REFUNDED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "orders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "productId" uuid NOT NULL, "vendorId" uuid NOT NULL, "buyerPhone" character varying NOT NULL, "buyerName" character varying NOT NULL, "buyerEmail" character varying, "quantity" integer NOT NULL, "unitPrice" numeric(10,2) NOT NULL, "totalAmount" numeric(10,2) NOT NULL, "platformFee" numeric(10,2) NOT NULL, "vendorAmount" numeric(10,2) NOT NULL, "fulfillmentType" "public"."orders_fulfillmenttype_enum" NOT NULL, "status" "public"."orders_status_enum" NOT NULL DEFAULT 'PENDING_PAYMENT', "paymentReference" character varying, "deliveryAddress" text, "notes" text, "paidAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_b7b57a54af0abc745545fe0f2b4" UNIQUE ("paymentReference"), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "unmapped_vendor_areas" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "vendorId" uuid NOT NULL, "rawValue" character varying(200) NOT NULL, "resolved" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_5ed37c40222f9d2d01c29745bf7" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_040df1ca778512ebe223f1f089" ON "unmapped_vendor_areas" ("vendorId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "refresh_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP WITH TIME ZONE, "token" character varying NOT NULL, "userId" uuid NOT NULL, "expiresAt" TIMESTAMP NOT NULL, "isRevoked" boolean NOT NULL DEFAULT false, "revokedAt" TIMESTAMP, "replacedByToken" character varying, CONSTRAINT "PK_7d8bee0204106019488c4c50ffa" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ca9661360d25617cc14c77ad32" ON "refresh_tokens" ("token", "userId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."pending_users_role_enum" AS ENUM('SUPER_ADMIN', 'ADMIN', 'SELLER', 'RIDER', 'BUYER')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."pending_users_vendortype_enum" AS ENUM('REGISTERED', 'NON_REGISTERED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."pending_users_ridertype_enum" AS ENUM('INDIVIDUAL', 'COMPANY')`,
    );
    await queryRunner.query(
      `CREATE TABLE "pending_users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "phoneNumber" character varying, "password" character varying NOT NULL, "firstName" character varying NOT NULL, "lastName" character varying NOT NULL, "role" "public"."pending_users_role_enum" NOT NULL DEFAULT 'SELLER', "vendorType" "public"."pending_users_vendortype_enum", "riderType" "public"."pending_users_ridertype_enum", "verificationCode" character varying NOT NULL, "verificationCodeExpiresAt" TIMESTAMP, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expiresAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_52d88bd887025f9814da7d28459" UNIQUE ("email"), CONSTRAINT "UQ_6ed4e9d382ff1a74d4590178a6f" UNIQUE ("phoneNumber"), CONSTRAINT "PK_4dcd5954b4aecb4d483a5c7e7d8" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "vendor_service_areas" ("vendorId" uuid NOT NULL, "areaId" uuid NOT NULL, CONSTRAINT "PK_1df39eef08750a42afaced1a59f" PRIMARY KEY ("vendorId", "areaId"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2272e78e6d454f9661bcc21490" ON "vendor_service_areas" ("vendorId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0a089b4258f87c03a91a3fc63c" ON "vendor_service_areas" ("areaId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "areas" ADD CONSTRAINT "FK_1ca0b120621195acf138968a36a" FOREIGN KEY ("stateId") REFERENCES "states"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" ADD CONSTRAINT "FK_6b00af9e9c38a1673f594de74f4" FOREIGN KEY ("vendorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_8624dad595ae567818ad9983b33" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_4fc5a9360e2b4e795f02344ae75" FOREIGN KEY ("vendorId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD CONSTRAINT "FK_610102b60fea1455310ccd299de" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "vendor_service_areas" ADD CONSTRAINT "FK_2272e78e6d454f9661bcc214909" FOREIGN KEY ("vendorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "vendor_service_areas" ADD CONSTRAINT "FK_0a089b4258f87c03a91a3fc63c9" FOREIGN KEY ("areaId") REFERENCES "areas"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "vendor_service_areas" DROP CONSTRAINT "FK_0a089b4258f87c03a91a3fc63c9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vendor_service_areas" DROP CONSTRAINT "FK_2272e78e6d454f9661bcc214909"`,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP CONSTRAINT "FK_610102b60fea1455310ccd299de"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_4fc5a9360e2b4e795f02344ae75"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_8624dad595ae567818ad9983b33"`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" DROP CONSTRAINT "FK_6b00af9e9c38a1673f594de74f4"`,
    );
    await queryRunner.query(
      `ALTER TABLE "areas" DROP CONSTRAINT "FK_1ca0b120621195acf138968a36a"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_0a089b4258f87c03a91a3fc63c"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_2272e78e6d454f9661bcc21490"`,
    );
    await queryRunner.query(`DROP TABLE "vendor_service_areas"`);
    await queryRunner.query(`DROP TABLE "pending_users"`);
    await queryRunner.query(
      `DROP TYPE "public"."pending_users_ridertype_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."pending_users_vendortype_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."pending_users_role_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ca9661360d25617cc14c77ad32"`,
    );
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_040df1ca778512ebe223f1f089"`,
    );
    await queryRunner.query(`DROP TABLE "unmapped_vendor_areas"`);
    await queryRunner.query(`DROP TABLE "orders"`);
    await queryRunner.query(`DROP TYPE "public"."orders_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."orders_fulfillmenttype_enum"`);
    await queryRunner.query(`DROP TABLE "products"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_bc0c27d77ee64f0a097a5c269b"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_1e3d0240b49c40521aaeb95329"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_97672ac88f789774dd47f7c8be"`,
    );
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "public"."users_ridertype_enum"`);
    await queryRunner.query(`DROP TYPE "public"."users_vendortype_enum"`);
    await queryRunner.query(`DROP TYPE "public"."users_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."users_role_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_8c2ad80240e18fcac9e7c52631"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_1ca0b120621195acf138968a36"`,
    );
    await queryRunner.query(`DROP TABLE "areas"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_fe52f02449eaf27be2b2cb7acd"`,
    );
    await queryRunner.query(`DROP TABLE "states"`);
  }
}
