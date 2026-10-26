import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Where a delivery goes, when the buyer picked it from Google Places: the place, and its
 * pin for the rider. Null for an address typed by hand — those have no pin.
 */
export class DeliveryPlaces1786041000000 implements MigrationInterface {
  name = 'DeliveryPlaces1786041000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['checkouts', 'orders']) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "deliveryPlaceId" character varying(300)`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "deliveryLat" numeric(9,6)`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "deliveryLng" numeric(9,6)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['checkouts', 'orders']) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "deliveryLng"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "deliveryLat"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "deliveryPlaceId"`,
      );
    }
  }
}
