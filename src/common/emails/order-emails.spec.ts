import {
  buildOnItsWayEmail,
  buildReceiptEmail,
  followLink,
} from './order-emails';
import { SUPPORT_PHONE } from '../support';

const links = {
  websiteUrl: 'https://recommend.ng',
  customerAppUrl: 'https://app.recommend.ng',
};

const receipt = (over = {}) =>
  buildReceiptEmail(
    {
      buyerName: 'Ada Obi',
      buyerEmail: 'ada+food@example.com',
      reference: 'REC-ABC123',
      fulfillmentType: 'DELIVERY',
      deliveryAddress: '12 Herbert Macaulay Way, Yaba',
      goodsTotal: 7000,
      deliveryFee: 1500,
      totalAmount: 8500,
      vendors: [
        {
          vendorName: 'Mama Ngozi Kitchen',
          items: [{ name: 'Suya Platter', quantity: 2, lineTotal: 7000 }],
        },
      ],
      ...over,
    },
    links,
  );

const onItsWay = (over = {}) =>
  buildOnItsWayEmail(
    {
      buyerName: 'Ada Obi',
      buyerEmail: 'ada+food@example.com',
      reference: 'REC-ABC123',
      deliveryCode: 'KQ7MRT',
      vendorNames: ['Mama Ngozi Kitchen'],
      rider: { name: 'Tunde Bakare', phone: '+234 800 000 9911' },
      ...over,
    },
    links,
  );

describe('the receipt', () => {
  it('says what was paid for, from whom, and the total', () => {
    const email = receipt();

    expect(email.subject).toBe(
      'Your order from Mama Ngozi Kitchen is paid — REC-ABC123',
    );
    for (const part of [email.html, email.text]) {
      expect(part).toContain('Hi Ada,');
      expect(part).toContain('2 × Suya Platter');
      expect(part).toContain('₦8,500');
      expect(part).toContain('12 Herbert Macaulay Way, Yaba');
    }
  });

  it('says the delivery code comes by email when it is on its way', () => {
    expect(receipt().text).toMatch(/delivery code will be emailed/i);
  });

  it('gives our number', () => {
    const email = receipt();
    expect(email.html).toContain(SUPPORT_PHONE);
    expect(email.text).toContain(SUPPORT_PHONE);
  });

  it('opens the chat signed in with their email — where the order is waiting', () => {
    const link = followLink(links, 'ada+food@example.com');
    expect(link).toBe(
      'https://app.recommend.ng/?signin=ada%2Bfood%40example.com',
    );
    expect(receipt().html).toContain(link);
  });

  it('names each vendor on a basket from several', () => {
    const email = receipt({
      vendors: [
        {
          vendorName: 'Mama Ngozi',
          items: [{ name: 'Suya', quantity: 1, lineTotal: 3000 }],
        },
        {
          vendorName: 'Iya Basira',
          items: [{ name: 'Amala', quantity: 1, lineTotal: 2500 }],
        },
      ],
    });
    expect(email.subject).toContain('Mama Ngozi and Iya Basira');
  });

  it('cannot be made to carry HTML through a vendor or item name', () => {
    const email = receipt({
      vendors: [
        {
          vendorName: '<script>x</script>',
          items: [
            {
              name: '<img src=x onerror=alert(1)>',
              quantity: 1,
              lineTotal: 100,
            },
          ],
        },
      ],
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<img src=x');
  });
});

describe('on its way', () => {
  it('puts the delivery code where it cannot be missed — subject, body and text', () => {
    const email = onItsWay();
    expect(email.subject).toBe('On its way — your delivery code is KQ7MRT');
    expect(email.html).toContain('KQ7MRT');
    expect(email.text).toContain('YOUR DELIVERY CODE: KQ7MRT');
  });

  it('gives the rider’s name and number, tappable', () => {
    const email = onItsWay();
    expect(email.html).toContain('Tunde Bakare');
    expect(email.html).toContain('tel:+2348000009911');
  });

  it('still works with no rider on record', () => {
    expect(onItsWay({ rider: null }).text).not.toContain('Your rider is');
  });

  it('gives our number and the way back to the chat', () => {
    const email = onItsWay();
    expect(email.text).toContain(SUPPORT_PHONE);
    expect(email.html).toContain('?signin=ada%2Bfood%40example.com');
  });
});
