/**
 * Turns identity documents uploaded before KYC went private into private files.
 *
 *   node --require ts-node/register scripts/make-kyc-private.ts            # report only
 *   node --require ts-node/register scripts/make-kyc-private.ts --apply    # convert
 *
 * Each public Cloudinary file is moved to the owner's private folder
 * (`recommend/kyc/<user id>/…`), its public link stops working (the CDN copy is
 * invalidated too), and the account keeps a `kyc:` reference instead of the link. Run it
 * against each environment's own database and Cloudinary account. Safe to run again:
 * what is already private is left alone.
 *
 * Old links in the admin edit history (vendor_admin_edits) stop opening once converted.
 * That is the point.
 */
import { config } from 'dotenv';
import { v2 as cloudinary } from 'cloudinary';
import { DataSource } from 'typeorm';
import { getTypeOrmConfig } from '../src/config/configuration';
import {
  KYC_DOCUMENTS,
  kycFolder,
  toKycRef,
} from '../src/modules/storage/kyc-ref';

config();

const apply = process.argv.includes('--apply');
const cloudName = process.env.CLOUDINARY_CLOUD_NAME;

/** https://res.cloudinary.com/<cloud>/<image|raw>/upload/[s--sig--/][v123/]<public id>.<ext> */
function parsePublicUrl(
  url: string,
): { resourceType: string; publicId: string; format: string } | null {
  const match =
    /^https:\/\/res\.cloudinary\.com\/([^/]+)\/(image|raw)\/upload\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+)\.([A-Za-z0-9]{2,5})$/.exec(
      url,
    );
  if (!match || match[1] !== cloudName) return null;
  return { resourceType: match[2], publicId: match[3], format: match[4] };
}

async function main(): Promise<void> {
  if (!cloudName) throw new Error('CLOUDINARY_CLOUD_NAME is not set');
  cloudinary.config({
    cloud_name: cloudName,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  // The app's connection settings, but never its migrations: running this must change
  // documents and nothing else. And no query log — the output is the report.
  const db = new DataSource({
    ...getTypeOrmConfig(),
    migrationsRun: false,
    logging: false,
  });
  await db.initialize();

  const columns = KYC_DOCUMENTS.map((c) => `"${c}"`).join(', ');
  const users = await db.query<Record<string, string | null>[]>(
    `SELECT id, ${columns} FROM users WHERE ${KYC_DOCUMENTS.map((c) => `"${c}" LIKE 'https://%'`).join(' OR ')}`,
  );

  let converted = 0;
  let skipped = 0;
  const perDocument = new Map<string, number>();

  for (const user of users) {
    for (const column of KYC_DOCUMENTS) {
      const value = user[column];
      if (!value?.startsWith('https://')) continue;

      const parsed = parsePublicUrl(value);
      if (!parsed) {
        // Not one of ours: an outside link, or another Cloudinary account. Reported, not
        // touched — an admin should look at it.
        skipped++;
        console.log(
          `SKIP  user ${user.id} ${column}: not a file in this Cloudinary account`,
        );
        continue;
      }
      perDocument.set(column, (perDocument.get(column) ?? 0) + 1);
      if (!apply) continue;

      const name = parsed.publicId.split('/').pop() ?? parsed.publicId;
      const target = `${kycFolder(String(user.id))}/${name}`;
      try {
        await cloudinary.uploader.rename(parsed.publicId, target, {
          resource_type: parsed.resourceType,
          type: 'upload',
          to_type: 'private',
          invalidate: true,
          overwrite: false,
        });
        await db.query(`UPDATE users SET "${column}" = $1 WHERE id = $2`, [
          toKycRef(parsed.resourceType, target, parsed.format),
          user.id,
        ]);
        converted++;
      } catch (error) {
        console.log(
          `FAIL  user ${user.id} ${column}: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
        );
      }
    }
  }

  console.log(
    `\nPublic documents found, by kind: ${
      [...perDocument].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'
    }`,
  );
  console.log(
    apply
      ? `Converted ${converted}; skipped ${skipped}.`
      : `Report only — nothing changed. Run again with --apply to convert. (${skipped} skipped)`,
  );
  await db.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
