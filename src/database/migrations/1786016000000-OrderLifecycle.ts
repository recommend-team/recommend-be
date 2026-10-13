import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The order lifecycle: two new statuses, and a record of who moved what.
 *
 * `READY` and `DISPATCHED` are inserted *after* `PAID` rather than appended, so the
 * enum's own sort order matches the order things happen in. Appending would leave
 * `ORDER BY status` producing a sequence that reads as nonsense to anyone who tries it.
 */
export class OrderLifecycle1786016000000 implements MigrationInterface {
  name = 'OrderLifecycle1786016000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Both `orders` and `checkouts` share this type.
    await queryRunner.query(
      `ALTER TYPE "public"."orders_status_enum" ADD VALUE IF NOT EXISTS 'READY' AFTER 'PAID'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."orders_status_enum" ADD VALUE IF NOT EXISTS 'DISPATCHED' AFTER 'READY'`,
    );

    /**
     * Every transition, including admin overrides.
     *
     * `fromStatus` and `toStatus` are plain text rather than the enum on purpose: an
     * audit row records what happened at the time, and must stay readable even if the
     * enum is later changed. A history that rewrites itself is not a history.
     *
     * `actorId` is nullable because the actor is not always a user row — a buyer has no
     * account, and a system action has nobody at all.
     */
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "order_status_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "orderId" uuid,
        "checkoutId" uuid,
        "fromStatus" character varying NOT NULL,
        "toStatus" character varying NOT NULL,
        "actorType" character varying NOT NULL,
        "actorId" uuid,
        "note" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_order_status_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ose_order" FOREIGN KEY ("orderId")
          REFERENCES "orders"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_ose_checkout" FOREIGN KEY ("checkoutId")
          REFERENCES "checkouts"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ose_orderId" ON "order_status_events" ("orderId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ose_checkoutId" ON "order_status_events" ("checkoutId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "order_status_events"`);
    // The enum values are deliberately left in place. Removing one means rebuilding the
    // type and every column that uses it, and any row already holding the value would
    // have nowhere to go.
  }
}
