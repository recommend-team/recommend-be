import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notifications and Web Push subscriptions.
 */
export class Notifications1786015000000 implements MigrationInterface {
  name = 'Notifications1786015000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."notifications_type_enum" AS ENUM(
        'NEW_ORDER', 'ORDER_PAID', 'ORDER_CANCELLED', 'KYC_APPROVED', 'KYC_REJECTED'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "type" "public"."notifications_type_enum" NOT NULL,
        "title" character varying NOT NULL,
        "body" text NOT NULL,
        "data" jsonb,
        "readAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notifications" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_notifications_userId" ON "notifications" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_notifications_createdAt" ON "notifications" ("createdAt")`,
    );
    // Backs the unread badge, which every dashboard page load asks for.
    await queryRunner.query(`
      CREATE INDEX "IDX_notifications_unread"
      ON "notifications" ("userId", "createdAt" DESC)
      WHERE "readAt" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "push_subscriptions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "endpoint" text NOT NULL,
        "keys" jsonb NOT NULL,
        "userAgent" character varying,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_push_subscriptions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_push_endpoint" UNIQUE ("endpoint"),
        CONSTRAINT "FK_push_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_push_userId" ON "push_subscriptions" ("userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "push_subscriptions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "notifications"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."notifications_type_enum"`,
    );
  }
}
