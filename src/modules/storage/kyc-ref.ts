/**
 * Identity documents are stored privately on Cloudinary, so what the database keeps is not
 * a link anyone can open but a reference: `kyc:<resource type>/<public id>.<format>`.
 * The public id carries the owner — `recommend/kyc/<user id>/<file>` — so a document can
 * only be attached to the account it was uploaded for. Viewing it takes a short-lived
 * link from `StorageService.kycViewUrl`, for admins only.
 */

/** Every user column that holds an identity document. */
export const KYC_DOCUMENTS = [
  'cacDocumentUrl',
  'tinDocumentUrl',
  'ninDocumentUrl',
  'passportPhotoUrl',
  'bankStatementUrl',
  'utilityBillUrl',
  'governmentIdUrl',
  'selfieUrl',
] as const;

export type KycDocument = (typeof KYC_DOCUMENTS)[number];

export function isKycDocument(value: string): value is KycDocument {
  return (KYC_DOCUMENTS as readonly string[]).includes(value);
}

export interface KycRef {
  resourceType: 'image' | 'raw';
  publicId: string;
  ownerId: string;
  format: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const REF = new RegExp(
  `^kyc:(image|raw)/(recommend/kyc/(${UUID})/[A-Za-z0-9_-]{1,120})\\.([a-z0-9]{2,5})$`,
);

/** Where an owner's documents live on Cloudinary. */
export function kycFolder(ownerId: string): string {
  return `recommend/kyc/${ownerId}`;
}

export function toKycRef(
  resourceType: string,
  publicId: string,
  format: string,
): string {
  return `kyc:${resourceType}/${publicId}.${format}`;
}

export function parseKycRef(value: string | null | undefined): KycRef | null {
  const match = value ? REF.exec(value) : null;
  if (!match) return null;
  return {
    resourceType: match[1] as 'image' | 'raw',
    publicId: match[2],
    ownerId: match[3],
    format: match[4],
  };
}

/** Uploaded through our private KYC upload, for this account. */
export function isKycRefFor(value: string, ownerId: string): boolean {
  return parseKycRef(value)?.ownerId === ownerId;
}
