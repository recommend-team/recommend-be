import { contactIn } from './waitlist.service';

describe('contactIn', () => {
  it.each([
    ['08031234567', '+2348031234567'],
    ['my number na 0803 123 4567 abeg', '+2348031234567'],
    ['+234 803 123 4567', '+2348031234567'],
    ['2348031234567', '+2348031234567'],
    ['0703-123-4567', '+2347031234567'],
    ['09012345678', '+2349012345678'],
  ])('reads the phone number in "%s"', (text, contact) => {
    expect(contactIn(text)).toEqual({ kind: 'PHONE', contact });
  });

  it('reads an email, lower-cased', () => {
    expect(contactIn('reach me on Ada.Obi@Gmail.com please')).toEqual({
      kind: 'EMAIL',
      contact: 'ada.obi@gmail.com',
    });
  });

  it.each([
    'I need food',
    'how much is 2000 naira',
    'call 0123',
    'order REC-1234567890',
    '0803123456', // a digit short
  ])('finds nothing in "%s"', (text) => {
    expect(contactIn(text)).toBeNull();
  });
});
