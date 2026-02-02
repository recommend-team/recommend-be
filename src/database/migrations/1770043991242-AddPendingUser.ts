import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPendingUser1770043991242 implements MigrationInterface {
  name = 'AddPendingUser1770043991242';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "pending_users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "password" character varying NOT NULL, "firstName" character varying NOT NULL, "lastName" character varying, "phoneNumber" character varying, "verificationCode" character varying NOT NULL, "verificationCodeExpiresAt" TIMESTAMP, "businessName" character varying, "businessAddress" character varying, "businessDescription" text, "businessCategory" character varying, "businessAreas" text array, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expiresAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_52d88bd887025f9814da7d28459" UNIQUE ("email"), CONSTRAINT "PK_4dcd5954b4aecb4d483a5c7e7d8" PRIMARY KEY ("id"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "pending_users"`);
  }
}
