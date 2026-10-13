import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EarningListener } from './earning.listener';
import { WalletService } from './wallet.service';
import { VendorOrderCompletedEvent } from '../../common/events/vendor-order-completed.event';
import { WALLET_CREDITED_EVENT } from '../../common/events/wallet.events';

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
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    wallet = { creditEarning: jest.fn().mockResolvedValue(2) };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EarningListener,
        { provide: WalletService, useValue: wallet },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    listener = module.get(EarningListener);
  });

  it('credits the vendor whose order was received', async () => {
    await listener.onVendorOrderCompleted(event);

    expect(wallet.creditEarning).toHaveBeenCalledWith(event);
  });

  it('announces the credit so the vendor can be told', async () => {
    await listener.onVendorOrderCompleted(event);

    expect(emitter.emit).toHaveBeenCalledWith(
      WALLET_CREDITED_EVENT,
      expect.objectContaining({ userId: 'v1', vendorAmount: 4800 }),
    );
  });

  it('stays quiet when the credit was a replay', async () => {
    // Nothing was written, so nothing happened. Telling a vendor twice that they were
    // paid once is worse than saying nothing.
    wallet.creditEarning.mockResolvedValue(0);

    await listener.onVendorOrderCompleted(event);

    expect(emitter.emit).not.toHaveBeenCalled();
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
