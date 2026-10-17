/**
 * Where a checkout was placed.
 *
 * The follow-up differs by it: a chat buyer is told everything in the chat they are
 * already in, while a storefront buyer may never open one — the team calls them.
 */
export enum CheckoutSource {
  /** By the buyer, in the Recommend chat. */
  CHAT = 'CHAT',
  /** On a vendor's own page — the link they share on their social media. */
  STOREFRONT = 'STOREFRONT',
  /** By an admin, on a buyer's behalf, from the admin chat. */
  ADMIN = 'ADMIN',
}
