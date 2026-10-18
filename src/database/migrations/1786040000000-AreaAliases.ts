import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Well-known places inside each Lagos area, so the assistant understands "Badore",
 * "Chevron" or "Allen Avenue" without the buyer knowing our area names. Added only for
 * areas that exist; admins add the rest from what buyers type.
 */
const SEED: Record<string, string[]> = {
  Ajah: [
    'Badore',
    'Abraham Adesanya',
    'Thomas Estate',
    'Addo',
    'Langbasa',
    'Mobil Road',
  ],
  Sangotedo: ['Abijo'],
  Lekki: [
    'Chevron',
    'Ikota',
    'VGC',
    'Victoria Garden City',
    'Agungi',
    'Jakande',
    'Osapa',
    'Osapa London',
    'Igbo Efon',
    'Idado',
    'Ologolo',
    'Ikate',
    'Elegushi',
    'Admiralty Way',
    'Freedom Way',
    'Orchid Road',
    'Chisco',
    'Lafiaji',
    'Lekki Phase One',
  ],
  'Ibeju-Lekki': ['Awoyaya', 'Eleko', 'Lakowe', 'Bogije'],
  Ikeja: [
    'Allen Avenue',
    'Opebi',
    'Computer Village',
    'Alausa',
    'Oregun',
    'Adeniyi Jones',
    'Toyin Street',
    'Awolowo Way',
    'Agidingbi',
  ],
  Egbeda: ['Gowon Estate', 'Akowonjo', 'Shasha'],
  Ikotun: ['Idimu', 'Igando', 'Ijegun', 'Egbe'],
  Ipaja: ['Ayobo', 'Baruwa', 'Abesan'],
  Alimosho: ['Abule Egba', 'Meiran', 'Akesan'],
  Agege: ['Pen Cinema', 'Dopemu', 'Oko Oba'],
  Ogba: ['Ifako', 'Oke Ira'],
  Ojodu: ['Berger', 'Omole'],
  Magodo: ['Shangisha', 'CMD Road'],
  Ketu: ['Alapere', 'Mile 12', 'Ikosi'],
  Maryland: ['Mende', 'Anthony Village'],
  Gbagada: ['Soluyi', 'Atunrase', 'Medina', 'Pedro'],
  Somolu: ['Shomolu', 'Bajulaiye', 'Fadeyi', 'Palmgrove', 'Onipanu'],
  Yaba: [
    'Sabo',
    'Jibowu',
    'Alagomeji',
    'Onike',
    'Iwaya',
    'Adekunle',
    'Tejuosho',
    'Herbert Macaulay',
  ],
  Akoka: ['Unilag', 'University of Lagos'],
  'Ebute Metta': ['Oyingbo', 'Otto', 'Iddo', 'Ebute Meta'],
  Surulere: [
    'Aguda',
    'Itire',
    'Ojuelegba',
    'Lawanson',
    'Bode Thomas',
    'Adeniran Ogunsanya',
    'Ogunlana',
    'Masha',
    'Iponri',
  ],
  Ijesha: ['Ijeshatedo'],
  Mushin: ['Idi Araba', 'Ladipo', 'Papa Ajao', 'Ilasamaja', 'Odi Olowo'],
  Isolo: ['Ago Palace', 'Okota', 'Ejigbo', 'Ajao Estate'],
  Oshodi: ['Bolade', 'Mafoluku'],
  'Amuwo-Odofin': [
    'Amuwo',
    'Mile 2',
    'Satellite Town',
    'Abule Ado',
    'Agboju',
    'Kirikiri',
  ],
  Apapa: ['Ajegunle', 'Wharf'],
  'Victoria Island': [
    'VI',
    'Oniru',
    'Ahmadu Bello',
    'Adeola Odeku',
    'Ajose Adeogun',
    'Eko Atlantic',
  ],
  Ikoyi: [
    'Obalende',
    'Falomo',
    'Dolphin Estate',
    'Parkview',
    'Banana Island',
    'Bourdillon',
  ],
  Ikorodu: ['Igbogbo', 'Ijede', 'Owutu', 'Ogolonto', 'Majidun', 'Odogunyan'],
};

/** As `normalisePlace` writes it — kept here so this migration never changes meaning. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export class AreaAliases1786040000000 implements MigrationInterface {
  name = 'AreaAliases1786040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "area_aliases" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "areaId" uuid NOT NULL,
        "name" character varying(80) NOT NULL,
        "normalised" character varying(80) NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_area_aliases" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_area_aliases_normalised" UNIQUE ("normalised"),
        CONSTRAINT "FK_area_aliases_area" FOREIGN KEY ("areaId")
          REFERENCES "areas"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_area_aliases_area" ON "area_aliases" ("areaId")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "unplaced_locations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "text" character varying(120) NOT NULL,
        "normalised" character varying(120) NOT NULL,
        "timesSeen" integer NOT NULL DEFAULT 1,
        "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "resolvedAreaId" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_unplaced_locations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_unplaced_locations_normalised" UNIQUE ("normalised")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_unplaced_locations_last_seen" ON "unplaced_locations" ("lastSeenAt")`,
    );

    for (const [area, names] of Object.entries(SEED)) {
      for (const name of names) {
        await queryRunner.query(
          `INSERT INTO "area_aliases" ("areaId", "name", "normalised")
           SELECT a."id", $2, $3 FROM "areas" a
            WHERE lower(a."name") = lower($1) AND a."deletedAt" IS NULL
            LIMIT 1
           ON CONFLICT ("normalised") DO NOTHING`,
          [area, name, normalise(name)],
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "unplaced_locations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "area_aliases"`);
  }
}
