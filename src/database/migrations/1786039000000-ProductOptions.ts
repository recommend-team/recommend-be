import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProductOptions1786039000000 implements MigrationInterface {
  name = 'ProductOptions1786039000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "unit" character varying(16)`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "product_extras" (
        "productId" uuid NOT NULL,
        "extraId" uuid NOT NULL,
        CONSTRAINT "PK_product_extras" PRIMARY KEY ("productId", "extraId"),
        CONSTRAINT "FK_product_extras_product" FOREIGN KEY ("productId")
          REFERENCES "products"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_product_extras_extra" FOREIGN KEY ("extraId")
          REFERENCES "products"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_product_extras_extra" ON "product_extras" ("extraId")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "product_choice_groups" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "productId" uuid NOT NULL,
        "name" character varying(60) NOT NULL,
        "required" boolean NOT NULL DEFAULT false,
        "minPick" integer NOT NULL DEFAULT 0,
        "maxPick" integer NOT NULL DEFAULT 1,
        "position" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_product_choice_groups" PRIMARY KEY ("id"),
        CONSTRAINT "FK_product_choice_groups_product" FOREIGN KEY ("productId")
          REFERENCES "products"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_product_choice_groups_product" ON "product_choice_groups" ("productId")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "product_choice_options" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "groupId" uuid NOT NULL,
        "name" character varying(60) NOT NULL,
        "priceDelta" numeric(10,2) NOT NULL DEFAULT 0,
        "isAvailable" boolean NOT NULL DEFAULT true,
        "position" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_product_choice_options" PRIMARY KEY ("id"),
        CONSTRAINT "FK_product_choice_options_group" FOREIGN KEY ("groupId")
          REFERENCES "product_choice_groups"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_product_choice_options_group" ON "product_choice_options" ("groupId")`,
    );

    // A pack: the dish row carries portions per pack and the number of identical packs;
    // its extras point back at it.
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "packs" integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "parentItemId" uuid`,
    );
    // The unit at purchase, so a receipt says "2 portions" even if the menu changes.
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "unit" character varying(16)`,
    );
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "order_items" ADD CONSTRAINT "FK_order_items_parent"
          FOREIGN KEY ("parentItemId") REFERENCES "order_items"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_order_items_parent" ON "order_items" ("parentItemId")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "order_item_choices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "orderItemId" uuid NOT NULL,
        "groupName" character varying(60) NOT NULL,
        "optionName" character varying(60) NOT NULL,
        "priceDelta" numeric(10,2) NOT NULL DEFAULT 0,
        CONSTRAINT "PK_order_item_choices" PRIMARY KEY ("id"),
        CONSTRAINT "FK_order_item_choices_item" FOREIGN KEY ("orderItemId")
          REFERENCES "order_items"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_order_item_choices_item" ON "order_item_choices" ("orderItemId")`,
    );

    // Nothing a buyer could add yesterday disappears: each existing extra goes with every
    // one of its vendor's dishes.
    await queryRunner.query(`
      INSERT INTO "product_extras" ("productId", "extraId")
      SELECT dish."id", extra."id"
        FROM "products" dish
        JOIN "products" extra
          ON extra."vendorId" = dish."vendorId" AND extra."isAddOn" = true
       WHERE dish."isAddOn" = false
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "order_item_choices"`);
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP CONSTRAINT IF EXISTS "FK_order_items_parent"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_order_items_parent"`);
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP COLUMN IF EXISTS "parentItemId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP COLUMN IF EXISTS "packs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" DROP COLUMN IF EXISTS "unit"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "product_choice_options"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "product_choice_groups"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "product_extras"`);
    await queryRunner.query(
      `ALTER TABLE "products" DROP COLUMN IF EXISTS "unit"`,
    );
  }
}
