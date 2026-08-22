import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Three notification types the wallet needs.
 *
 * Appended rather than inserted in lifecycle order — unlike `OrderStatus`, nothing sorts
 * on this enum, so position carries no meaning and appending is the cheaper change.
 *
 * `down()` cannot remove them: dropping a value from a Postgres enum means rebuilding the
 * type and every column using it. Leaving three unused labels behind is the smaller cost.
 */
export class WalletNotifications1786020000000 implements MigrationInterface {
  name = 'WalletNotifications1786020000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of [
      'WALLET_CREDITED',
      'WITHDRAWAL_SETTLED',
      'WITHDRAWAL_FAILED',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "public"."notifications_type_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
  }

  public async down(): Promise<void> {
    // Deliberately empty. See the note above.
  }
}
