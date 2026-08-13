import { Test, TestingModule } from '@nestjs/testing';
import { EarningListener } from './earning.listener';
import { WalletService } from './wallet.service';
import { VendorOrderCompletedEvent } from '../../common/events/vendor-order-completed.event';

const event = new VendorOrderCompletedEvent(
  'o1',
  'ck1',
  'v1',
  'REC-AAA',
  6000,
  1200,
  4800,
);

describe('EarningListener', () => {
  let listener: EarningListener;
  let wallet: { creditEarning: jest.Mock };

  beforeEach(async () => {
    wallet = { creditEarning: jest.fn().mockResolvedValue(2) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EarningListener,
        { provide: WalletService, useValue: wallet },
      ],
    }).compile();

    listener = module.get(EarningListener);
  });

  it('credits the vendor whose order was received', async () => {
    await listener.onVendorOrderCompleted(event);

    expect(wallet.creditEarning).toHaveBeenCalledWith(event);
  });

  it('swallows a ledger failure rather than unwinding the delivery', async () => {
    // The goods arrived. Failing the transition because the bookkeeping failed would
    // rewrite a fact about the physical world to protect a number we can recompute.
    wallet.creditEarning.mockRejectedValue(new Error('db down'));

    await expect(
      listener.onVendorOrderCompleted(event),
    ).resolves.toBeUndefined();
  });
});
