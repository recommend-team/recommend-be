import { WelcomeEmailService } from './welcome-email.service';

describe('WelcomeEmailService', () => {
  const config = {
    get: jest.fn(
      (key: string) =>
        ({
          'brand.websiteUrl': 'https://recommend-fe.netlify.app',
          'brand.customerAppUrl': 'https://order.example',
          'brand.vendorAppUrl': 'https://vendors.example',
          'contact.inbox': 'contacts.recommend@gmail.com',
        })[key],
    ),
  };

  it('sends the note with replies going to the team inbox', async () => {
    const email = { sendEmail: jest.fn().mockResolvedValue(undefined) };
    const service = new WelcomeEmailService(email as never, config as never);

    await service.send('vendor', 'ada@example.com', 'Ada');

    expect(email.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ada@example.com',
        subject: 'Welcome to Recommend, Ada — a note from me',
        replyTo: {
          email: 'contacts.recommend@gmail.com',
          name: 'Chanor James, Recommend',
        },
      }),
    );
  });

  it('never throws — a failed welcome must not fail the sign-up', async () => {
    const email = { sendEmail: jest.fn().mockRejectedValue(new Error('down')) };
    const service = new WelcomeEmailService(email as never, config as never);

    await expect(
      service.send('customer', 'ada@example.com', 'Ada'),
    ).resolves.toBeUndefined();
  });
});
