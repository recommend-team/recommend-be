/**
 * Email, as the chat context needs it: send a buyer the code that signs them in.
 *
 * The platform owns the provider and the sending. When the chat becomes a service, this
 * is an HTTP call and nothing in the account flow changes.
 */

export const EMAIL_PORT = Symbol('EMAIL_PORT');

export interface EmailPort {
  /** Throws when the email could not be handed to the provider. */
  sendSignInCode(to: string, code: string, minutesValid: number): Promise<void>;
}
