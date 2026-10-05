import { databaseConfig, readCaCert } from './configuration';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';

describe('database TLS', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.DATABASE_CA_CERT;
    delete process.env.DATABASE_SSL;
    process.env.DATABASE_URL =
      'postgres://u:p@db.example.com:24481/defaultdb?sslmode=require';
  });

  afterAll(() => {
    process.env = saved;
  });

  const config = () => databaseConfig();

  it('verifies against the provider CA when DATABASE_CA_CERT is set', () => {
    process.env.DATABASE_CA_CERT = PEM;

    expect(config().ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
  });

  it('prefers the CA over DATABASE_SSL=true — verified beats unverified', () => {
    process.env.DATABASE_CA_CERT = PEM;
    process.env.DATABASE_SSL = 'true';

    expect(config().ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
  });

  it('falls back to encrypted-but-unverified with DATABASE_SSL=true', () => {
    process.env.DATABASE_SSL = 'true';

    expect(config().ssl).toEqual({ rejectUnauthorized: false });
  });

  it('leaves a local database alone', () => {
    process.env.DATABASE_URL =
      'postgresql://postgres:postgres@localhost:5432/recommend_db';

    expect(config().ssl).toBeUndefined();
    expect(config().url).toBe(process.env.DATABASE_URL);
  });

  it('strips every URL TLS setting pg would apply over the ssl option', () => {
    // pg merges URL parameters on top of `ssl`, so any of these would bring back full
    // verification against the system CAs — and the original error.
    process.env.DATABASE_SSL = 'true';
    process.env.DATABASE_URL =
      'postgres://u:p@db.example.com:24481/defaultdb?sslmode=require&ssl=true' +
      '&sslrootcert=/x.pem&uselibpqcompat=true&application_name=recommend';

    const url = new URL(config().url);

    expect([...url.searchParams.keys()]).toEqual(['application_name']);
    expect(url.host).toBe('db.example.com:24481');
    expect(url.password).toBe('p');
  });

  describe('reading the certificate', () => {
    it('accepts a single-line value with \\n escapes, as dashboards store it', () => {
      expect(readCaCert(PEM.replace(/\n/g, '\\n'))).toBe(PEM);
    });

    it('accepts real multi-line text', () => {
      expect(readCaCert(`  ${PEM}\n`)).toBe(PEM);
    });

    it('treats an empty value as unset', () => {
      expect(readCaCert('')).toBeNull();
      expect(readCaCert(undefined)).toBeNull();
    });

    it('refuses something that is not a certificate, rather than failing later on TLS', () => {
      expect(() => readCaCert('avnadmin-password-by-mistake')).toThrow(
        /not a PEM certificate/,
      );
    });
  });
});
