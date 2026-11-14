import { BadRequestException } from '@nestjs/common';
import { StorageService } from './storage.service';
import { isKycRefFor, parseKycRef, toKycRef } from './kyc-ref';
import { SellersService } from '../sellers/sellers.service';
import { VendorType } from '../../common/enums/vendor-type.enum';

const OWNER = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const OTHER = '6fa459ea-ee8a-4ca4-894e-db77e160355e';
const REF = toKycRef('image', `recommend/kyc/${OWNER}/nin_x7`, 'jpg');

describe('KYC references', () => {
  it('reads what an upload stored, owner included', () => {
    expect(parseKycRef(REF)).toEqual({
      resourceType: 'image',
      publicId: `recommend/kyc/${OWNER}/nin_x7`,
      ownerId: OWNER,
      format: 'jpg',
    });
  });

  it.each([
    'https://res.cloudinary.com/demo/image/upload/v1/recommend/kyc/nin.jpg',
    'https://evil.example.com/track.gif',
    `kyc:image/recommend/general/${OWNER}/x.jpg`,
    `kyc:video/recommend/kyc/${OWNER}/x.mp4`,
    '',
  ])('is not fooled by %p', (value) => {
    expect(parseKycRef(value)).toBeNull();
  });

  it('belongs only to the account it was uploaded for', () => {
    expect(isKycRefFor(REF, OWNER)).toBe(true);
    expect(isKycRefFor(REF, OTHER)).toBe(false);
  });
});

describe('StorageService and identity documents', () => {
  const storage = new StorageService({
    get: (key: string) =>
      ({
        'cloudinary.cloudName': 'demo',
        'cloudinary.apiKey': '123',
        'cloudinary.apiSecret': 'secret',
      })[key],
  } as never);

  it('never uploads an identity document as a public file', async () => {
    const file = {
      mimetype: 'image/jpeg',
      size: 10,
      buffer: Buffer.from('x'),
    } as Express.Multer.File;

    await expect(storage.uploadFile(file, 'kyc')).rejects.toThrow(
      'uploaded privately',
    );
  });

  it('gives a link that is signed and expires within minutes', () => {
    const link = storage.kycViewUrl(REF);

    expect(link?.legacy).toBe(false);
    expect(link?.url).toContain('api.cloudinary.com/v1_1/demo/image/download');
    expect(link?.url).toContain('type=private');
    expect(link?.url).toContain('signature=');
    const minutes =
      (new Date(link?.expiresAt ?? 0).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(4);
    expect(minutes).toBeLessThanOrEqual(5);
  });

  it('passes an old public link through until it is converted, and nothing else', () => {
    const old =
      'https://res.cloudinary.com/demo/image/upload/v1/recommend/kyc/nin.jpg';
    expect(storage.kycViewUrl(old)).toEqual({
      url: old,
      expiresAt: '',
      legacy: true,
    });
    expect(storage.kycViewUrl('https://evil.example.com/a.jpg')).toBeNull();
    expect(storage.kycViewUrl(null)).toBeNull();
  });
});

describe('submitting documents', () => {
  const vendor = {
    id: OWNER,
    vendorType: VendorType.NON_REGISTERED,
    serviceAreas: [],
  };
  const save = jest.fn((v: unknown) => Promise.resolve(v));
  const sellers = new SellersService(
    { findOne: jest.fn().mockResolvedValue(vendor), save } as never,
    {} as never,
    {} as never,
  );

  beforeEach(() => save.mockClear());

  it('takes a document uploaded privately for this vendor', async () => {
    await sellers.updateKyc(OWNER, { ninDocumentUrl: REF });

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ ninDocumentUrl: REF }),
    );
  });

  it.each([
    [
      'someone else’s document',
      toKycRef('image', `recommend/kyc/${OTHER}/a`, 'jpg'),
    ],
    [
      'an outside link',
      'https://res.cloudinary.com/demo/image/upload/v1/a.jpg',
    ],
  ])('refuses %s', async (_label, value) => {
    await expect(
      sellers.updateKyc(OWNER, { ninDocumentUrl: value }),
    ).rejects.toThrow(BadRequestException);
    expect(save).not.toHaveBeenCalled();
  });
});
