import {
  DEFAULT_SUPPORT_EMAIL,
  DEFAULT_SUPPORT_PHONE,
  supportEmail,
  supportPhone,
  supportPhoneHref,
} from './support';

describe('support details', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('falls back to the defaults when nothing is set', () => {
    delete process.env.SUPPORT_PHONE;
    delete process.env.SUPPORT_EMAIL;

    expect(supportPhone()).toBe(DEFAULT_SUPPORT_PHONE);
    expect(supportPhoneHref()).toBe('tel:+2348143067676');
    expect(supportEmail()).toBe(DEFAULT_SUPPORT_EMAIL);
  });

  it('treats a blank variable as unset', () => {
    process.env.SUPPORT_PHONE = '   ';
    process.env.SUPPORT_EMAIL = '';

    expect(supportPhone()).toBe(DEFAULT_SUPPORT_PHONE);
    expect(supportEmail()).toBe(DEFAULT_SUPPORT_EMAIL);
  });

  it('uses the variables when set, read at the time of use', () => {
    process.env.SUPPORT_PHONE = '+234 701 234 5678';
    process.env.SUPPORT_EMAIL = 'help@recommend.ng';

    expect(supportPhone()).toBe('+234 701 234 5678');
    expect(supportPhoneHref()).toBe('tel:+2347012345678');
    expect(supportEmail()).toBe('help@recommend.ng');
  });
});
