import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProductsAndOrders1770080000000 implements MigrationInterface {
  name = 'ProductsAndOrders1770080000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Storefront slug on users ──────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "slug" varchar UNIQUE
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_slug" ON "users" ("slug")
    `);

    // ── 2. Enums ─────────────────────────────────────────────────────────────
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "order_status_enum" AS ENUM (
          'PENDING_PAYMENT', 'PAID', 'PROCESSING', 'COMPLETED', 'CANCELLED', 'REFUNDED'
        );
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "fulfillment_type_enum" AS ENUM ('PICKUP', 'DELIVERY');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);

    // ── 3. Products table ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "products" (
        "id"          uuid        NOT NULL DEFAULT uuid_generate_v4(),
        "vendorId"    uuid        NOT NULL,
        "name"        varchar     NOT NULL,
        "description" text,
        "price"       decimal(10,2) NOT NULL,
        "imageUrl"    varchar,
        "isAvailable" boolean     NOT NULL DEFAULT true,
        "createdAt"   timestamptz NOT NULL DEFAULT now(),
        "updatedAt"   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_products" PRIMARY KEY ("id"),
        CONSTRAINT "FK_products_vendor"
          FOREIGN KEY ("vendorId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_products_vendorId" ON "products" ("vendorId")
    `);

    // ── 4. Orders table ───────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "orders" (
        "id"               uuid                    NOT NULL DEFAULT uuid_generate_v4(),
        "productId"        uuid                    NOT NULL,
        "vendorId"         uuid                    NOT NULL,
        "buyerPhone"       varchar                 NOT NULL,
        "buyerName"        varchar                 NOT NULL,
        "buyerEmail"       varchar,
        "quantity"         integer                 NOT NULL,
        "unitPrice"        decimal(10,2)           NOT NULL,
        "totalAmount"      decimal(10,2)           NOT NULL,
        "platformFee"      decimal(10,2)           NOT NULL,
        "vendorAmount"     decimal(10,2)           NOT NULL,
        "fulfillmentType"  fulfillment_type_enum   NOT NULL,
        "status"           order_status_enum       NOT NULL DEFAULT 'PENDING_PAYMENT',
        "paymentReference" varchar                 UNIQUE,
        "deliveryAddress"  text,
        "notes"            text,
        "paidAt"           timestamptz,
        "createdAt"        timestamptz             NOT NULL DEFAULT now(),
        "updatedAt"        timestamptz             NOT NULL DEFAULT now(),
        CONSTRAINT "PK_orders" PRIMARY KEY ("id"),
        CONSTRAINT "FK_orders_product"
          FOREIGN KEY ("productId") REFERENCES "products"("id"),
        CONSTRAINT "FK_orders_vendor"
          FOREIGN KEY ("vendorId") REFERENCES "users"("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_orders_vendorId" ON "orders" ("vendorId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_orders_status" ON "orders" ("status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "orders"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "products"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "order_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "fulfillment_type_enum"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_slug"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "slug"`);
  }
}
