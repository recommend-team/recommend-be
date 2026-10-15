import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Record what buyers searched for that nothing matched exactly.
 *
 * The chat now offers the nearest available thing instead of a dead end, which keeps the
 * buyer but hides the gap. This keeps the gap on record — what is wanted where, that no
 * vendor sells — so it can be filled.
 *
 * No foreign keys on purpose: the demand outlives the conversation it came from.
 */
export class UnmetSearches1786034000000 implements MigrationInterface {
  name = 'UnmetSearches1786034000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "unmet_searches" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "query" character varying(200) NOT NULL,
        "areaId" uuid,
        "conversationId" uuid,
        "alternatives" character varying(16) NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_unmet_searches" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_unmet_searches_area_created"
        ON "unmet_searches" ("areaId", "createdAt")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_unmet_searches_created"
        ON "unmet_searches" ("createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "unmet_searches"`);
  }
}
