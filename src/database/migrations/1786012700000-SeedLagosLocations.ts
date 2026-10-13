import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Starting location data, split out of the schema migration so the seed can be
 * re-run, extended or corrected without touching table definitions.
 *
 * Admin owns the list from here — anything below can be added to, renamed or
 * deactivated at runtime, so `down()` only removes rows that are still untouched
 * and unreferenced.
 */
export class SeedLagosLocations1786012700000 implements MigrationInterface {
  name = 'SeedLagosLocations1786012700000';

  private static readonly LAGOS_AREAS = [
    'Agege',
    'Ajah',
    'Akoka',
    'Alimosho',
    'Amuwo-Odofin',
    'Apapa',
    'Badagry',
    'Bariga',
    'Ebute Metta',
    'Egbeda',
    'Epe',
    'Festac',
    'Gbagada',
    'Ibeju-Lekki',
    'Ijesha',
    'Ikeja',
    'Ikorodu',
    'Ikotun',
    'Ikoyi',
    'Ilupeju',
    'Ipaja',
    'Isolo',
    'Ketu',
    'Lekki',
    'Magodo',
    'Maryland',
    'Mushin',
    'Ogba',
    'Ogudu',
    'Ojodu',
    'Ojota',
    'Oshodi',
    'Sangotedo',
    'Somolu',
    'Surulere',
    'Victoria Island',
    'Yaba',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "states" ("name", "code") VALUES ('Lagos', 'LA')
       ON CONFLICT ("name") DO NOTHING`,
    );

    for (const area of SeedLagosLocations1786012700000.LAGOS_AREAS) {
      await queryRunner.query(
        `INSERT INTO "areas" ("stateId", "name")
         SELECT id, $1 FROM "states" WHERE "name" = 'Lagos'
         ON CONFLICT ("stateId", "name") DO NOTHING`,
        [area],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Leave behind any area a vendor already covers — dropping those would
    // silently strip vendor coverage on a rollback.
    await queryRunner.query(
      `DELETE FROM "areas" a
       USING "states" s
       WHERE a."stateId" = s."id"
         AND s."name" = 'Lagos'
         AND a."name" = ANY($1::text[])
         AND NOT EXISTS (
           SELECT 1 FROM "vendor_service_areas" vsa WHERE vsa."areaId" = a."id"
         )`,
      [SeedLagosLocations1786012700000.LAGOS_AREAS],
    );

    await queryRunner.query(
      `DELETE FROM "states" s
       WHERE s."name" = 'Lagos'
         AND NOT EXISTS (SELECT 1 FROM "areas" a WHERE a."stateId" = s."id")`,
    );
  }
}
