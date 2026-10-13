/**
 * What the wallet announces.
 *
 * Plain data, like the other event contracts here, so the wallet module never holds a
 * reference to the notifications module and either can be read without the other.
 */

export const WALLET_CREDITED_EVENT = 'wallet.credited';
export const WITHDRAWAL_SETTLED_EVENT = 'wallet.withdrawal.settled';
export const WITHDRAWAL_FAILED_EVENT = 'wallet.withdrawal.failed';

/**
 * A delivered order has been credited. Emitted only when entries were actually written,
 * so a replayed completion — which credits nothing — also notifies nobody.
 */
export class WalletCreditedEvent {
  constructor(
    readonly userId: string,
    readonly orderId: string,
    /** Net of commission: what the balance actually went up by. */
    readonly vendorAmount: number,
    readonly reference: string,
  ) {}
}

export class WithdrawalSettledEvent {
  constructor(
    readonly userId: string,
    readonly withdrawalId: string,
    readonly reference: string,
    /** What reached the bank, after the transfer fee. */
    readonly amountSent: number,
  ) {}
}

export class WithdrawalFailedEvent {
  constructor(
    readonly userId: string,
    readonly withdrawalId: string,
    readonly reference: string,
    /** Credited back in full — the fee is only charged on a transfer that went out. */
    readonly amountReturned: number,
    readonly reason: string,
    /** `REVERSED` means it left and came back, which reads differently to a vendor. */
    readonly reversed: boolean,
  ) {}
}
