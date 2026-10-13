import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-vendor checkout.
 *
 * A buyer fills one basket that may span several restaurants and pays once. That
 * cannot be modelled on `orders` alone: `paymentReference` was UNIQUE, so two
 * vendors' orders could never share a charge, and an array of vendor ids cannot hold
 * per-vendor money or status.
 *
 *   checkout (one Paystack charge)
 *     └─ order (one per vendor: their subtotal, their 20%, their payout, their status)
 *          └─ order_items (what was actually bought, with price snapshots)
 *
 * Existing single-product orders are migrated into that shape rather than dropped:
 * each becomes one checkout with one order and one item, keeping its reference,
 * totals and status.
 */
export class CheckoutAndOrderItems1786014000000 implements MigrationInterface {
  name = 'CheckoutAndOrderItems1786014000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─── checkouts ────────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "checkouts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "reference" character varying NOT NULL,
        "buyerId" uuid,
        "buyerName" character varying NOT NULL,
        "buyerPhone" character varying NOT NULL,
        "buyerEmail" character varying,
        "fulfillmentType" "public"."orders_fulfillmenttype_enum" NOT NULL,
        "deliveryAddress" text,
        "notes" text,
        "goodsTotal" numeric(10,2) NOT NULL,
        "deliveryFee" numeric(10,2) NOT NULL DEFAULT 0,
        "totalAmount" numeric(10,2) NOT NULL,
        "status" "public"."orders_status_enum" NOT NULL DEFAULT 'PENDING_PAYMENT',
        "paidAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_checkouts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_checkouts_reference" UNIQUE ("reference")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_checkouts_reference" ON "checkouts" ("reference")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_checkouts_buyerId" ON "checkouts" ("buyerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_checkouts_buyerPhone" ON "checkouts" ("buyerPhone")`,
    );

    // ─── order_items ──────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "order_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "orderId" uuid NOT NULL,
        "productId" uuid,
        "productName" character varying(100) NOT NULL,
        "unitPrice" numeric(10,2) NOT NULL,
        "quantity" integer NOT NULL,
        "lineTotal" numeric(10,2) NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_order_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_order_items_order" FOREIGN KEY ("orderId")
          REFERENCES "orders"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_order_items_product" FOREIGN KEY ("productId")
          REFERENCES "products"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_order_items_orderId" ON "order_items" ("orderId")`,
    );

    // ─── orders gains checkoutId ──────────────────────────────────────────────

    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN "checkoutId" uuid`,
    );

    // ─── Migrate existing orders into the new shape ───────────────────────────
    // One checkout per existing order, keeping its reference so any Paystack
    // webhook still in flight resolves to the right row.

    await queryRunner.query(`
      INSERT INTO "checkouts" (
        "id","reference","buyerName","buyerPhone","buyerEmail","fulfillmentType",
        "deliveryAddress","notes","goodsTotal","deliveryFee","totalAmount",
        "status","paidAt","createdAt","updatedAt"
      )
      SELECT
        uuid_generate_v4(),
        COALESCE(o."paymentReference", 'LEGACY-' || o.id::text),
        o."buyerName", o."buyerPhone", o."buyerEmail", o."fulfillmentType",
        o."deliveryAddress", o."notes",
        o."totalAmount", 0, o."totalAmount",
        o."status", o."paidAt", o."createdAt", o."updatedAt"
      FROM "orders" o
    `);

    await queryRunner.query(`
      UPDATE "orders" o
      SET "checkoutId" = c.id
      FROM "checkouts" c
      WHERE c."reference" = COALESCE(o."paymentReference", 'LEGACY-' || o.id::text)
    `);

    // One item per legacy order, snapshotting the product name as it stands now —
    // the best available record of what was bought.
    await queryRunner.query(`
      INSERT INTO "order_items" (
        "id","orderId","productId","productName","unitPrice","quantity","lineTotal","createdAt"
      )
      SELECT
        uuid_generate_v4(), o.id, o."productId",
        COALESCE(p."name", 'Unknown item'),
        o."unitPrice", o."quantity", o."totalAmount", o."createdAt"
      FROM "orders" o
      LEFT JOIN "products" p ON p.id = o."productId"
    `);

    // ─── Drop what moved ──────────────────────────────────────────────────────

    await queryRunner.query(
      `ALTER TABLE "orders" ALTER COLUMN "checkoutId" SET NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "orders"
      ADD CONSTRAINT "FK_orders_checkout" FOREIGN KEY ("checkoutId")
        REFERENCES "checkouts"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_checkoutId" ON "orders" ("checkoutId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_buyerPhone" ON "orders" ("buyerPhone")`,
    );

    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "paymentReference"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "productId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "quantity"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "unitPrice"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "productId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "quantity" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "unitPrice" numeric(10,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "paymentReference" character varying`,
    );

    // Collapse back to one product per order — only the first item survives, which
    // is lossy for any genuinely multi-item order placed since the upgrade.
    await queryRunner.query(`
      UPDATE "orders" o
      SET "productId" = first_item."productId",
          "quantity" = first_item."quantity",
          "unitPrice" = first_item."unitPrice"
      FROM (
        SELECT DISTINCT ON ("orderId") "orderId","productId","quantity","unitPrice"
        FROM "order_items" ORDER BY "orderId","createdAt"
      ) first_item
      WHERE o.id = first_item."orderId"
    `);

    await queryRunner.query(`
      UPDATE "orders" o SET "paymentReference" = c."reference"
      FROM "checkouts" c WHERE c.id = o."checkoutId"
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS "order_items"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "FK_orders_checkout"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN IF EXISTS "checkoutId"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "checkouts"`);
  }
}
