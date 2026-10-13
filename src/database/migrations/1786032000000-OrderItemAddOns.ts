import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Whether an order line was bought as an add-on (ADDONS_PLAN.md, sprint A3), recorded at
 * purchase like its name and price — the vendor's order view labels it so the kitchen
 * packs it with the meal. Every line before add-ons existed was a main item.
 */
export class OrderItemAddOns1786032000000 implements MigrationInterface {
  name = 'OrderItemAddOns1786032000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD "isAddOn" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "order_items" DROP COLUMN "isAddOn"`);
  }
}
