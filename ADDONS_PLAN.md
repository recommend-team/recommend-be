# Add-ons at checkout

Status: **built — sprints A1–A4 complete.** The optional dashboard nudge (A3.4) was left out.

## What we are building

Before paying, a buyer is offered extras from the vendor whose food is in their cart —
water, juice, extra beef — in any quantity. They are added to the order and to the total
the buyer pays.

```
Ada adds Jollof Rice (Mama Ngozi Kitchen) to her cart → taps Pay

James: Anything to go with it?
  ┌─────────────────────────────────────────────┐
  │ From Mama Ngozi Kitchen                      │
  │ Extra beef        ₦800    [ − 0 + ]          │
  │ Bottled water     ₦300    [ − 2 + ]          │
  │ Chapman           ₦1,200  [ − 1 + ]          │
  │                                              │
  │ [ Add & continue — ₦1,800 ]   No, thanks     │
  └─────────────────────────────────────────────┘
        ↓
  the usual checkout — details or address, summary (add-ons listed), pay
```

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | An add-on is an **ordinary product** with an `isAddOn` flag — not a dish option | Cart, checkout, price re-checks, vendor orders and earnings already handle products. Add-ons cost no new order model. |
| 2 | **Vendors** mark their own add-ons, in the vendor app | They know their menu and prices; admins are not a bottleneck. |
| 3 | Add-ons are **always from the same vendor** as a main item in the cart | One kitchen packs it, one delivery carries it, that vendor is paid for it. |
| 4 | An add-on is **never ordered alone** | No ₦300 water-only orders; a vendor who sells drinks on their own lists them as normal products. |
| 5 | Offered **in the chat** after tapping Pay, **and in the cart** | The chat prompt is where extra sales come from; the cart lets a buyer change their mind. |
| 6 | Asked **once per order**, and only if that vendor has add-ons | Never a nag; nothing to offer means no step. |
| 7 | **James never recommends an add-on** on its own | Someone asking for food is not shown "extra beef". |
| 8 | Prices are **recomputed on the server**, as for every cart line | What the card shows is what is charged. |

**Not in scope:** dish options ("choose your protein: beef or chicken +₦500"), add-ons shared
between vendors, and add-ons tied to one specific dish. Revisit if vendors ask.

## Rules the server enforces

- `isAddOn` products are excluded from discovery: catalogue search, the vendor list a
  buyer is shown, and anything the model can call.
- At checkout, every add-on line must have **at least one main (non-add-on) line from the
  same vendor**. Otherwise the checkout is refused with a clear reason (`ADDON_WITHOUT_MAIN`),
  surfaced to the buyer like the existing cart-changed reasons.
- An unavailable add-on behaves like any unavailable product: the existing
  `UNAVAILABLE` cart-change path.
- Quantities are capped like any line (50).

---

## Sprint A1 — Backend

**Goal:** add-ons exist, are kept out of discovery, are offered once in the checkout chat, and
are validated at payment.

1. **Data**
   - Migration: `products.isAddOn boolean NOT NULL DEFAULT false`, plus an index on
     `(vendorId, isAddOn)`.
   - `Product.isAddOn`; `create-product.dto` / `update-product.dto` accept it (optional,
     default `false`).
2. **Catalogue**
   - `LocalCatalogAdapter`: product search and vendor-product listings filter
     `isAddOn = false`.
   - New port method `listAddOns(vendorIds: string[])` → available add-ons per vendor,
     with prices from the database.
   - `ProductSummary` gains `isAddOn`, so the client can tell them apart.
3. **Checkout validation** (`checkout.service.ts`)
   - After `loadProducts`, reject any add-on line whose vendor has no main line in the cart
     (`ADDON_WITHOUT_MAIN`).
   - Add-on lines are otherwise priced, grouped by vendor and credited like any line — no
     change to totals, orders or wallets.
4. **Checkout chat** (`checkout.flow.ts`)
   - New state `OFFERING_ADDONS`, entered from `start` *before* the details steps, only when
     a vendor in the cart has add-ons and the offer has not been made for this cart
     (`context.addOnsOffered`, cleared with the cart).
   - Prompt: *"Anything to go with it?"* with a new payload `addon_offer`:
     `{ vendors: [{ vendorId, vendorName, items: [{ productId, name, price, imageUrl }] }] }`.
   - Answers:
     - the client sends the chosen lines (new socket event `checkout:addons`,
       `{ items: [{ productId, quantity }] }`); the server validates them as add-ons of a
       vendor in the cart, merges them into `pendingCart`, and continues;
     - "No, thanks" (tapped or typed) continues unchanged.
   - Then the existing flow: name → phone → email, or the returning-buyer address question.
   - Migration for the new enum value, as with `COLLECTING_EMAIL`.
5. **Order summary** — add-ons appear as ordinary item lines (no change needed; verify).
6. **Tests**
   - Search never returns an add-on; `listAddOns` returns only available ones for the given
     vendors.
   - Checkout refuses an add-on alone, and one from a vendor with no main line; accepts
     one alongside a main line from its vendor; totals include it.
   - The flow offers once, skips when there is nothing to offer, merges chosen lines,
     continues on "No, thanks", and never re-offers for the same cart.

**Done when:** an add-on product, created through the API, is offered after Pay, can be added,
appears on the summary and in the Paystack amount, and cannot be bought alone.

## Sprint A2 — Customer app

**Goal:** buyers can see and pick add-ons in the chat and the cart.

1. **Add-on card** (`components/chat/cards/AddOnOfferCard.tsx`) for the `addon_offer` payload:
   one section per vendor, a stepper per item (reuse `QuantityStepper`), a running total on
   the button — *"Add & continue — ₦1,800"* — and *"No, thanks"*. Interactive only while live,
   like the other cards; from history it shows what was added.
2. **Socket**: `chatClient.addAddOns(items)` → `checkout:addons`; contract types for the
   payload and the event.
3. **Cart sheet**: an *"Add extras"* section under each vendor's items, listing that vendor's
   add-ons with steppers. Shown only when the cart has a main item from that vendor; removing
   the last main item removes its add-ons too, with a short note.
4. **Vendor menu sheet**: add-ons listed apart, under *"Extras"*, addable only once a main
   item from that vendor is in the cart.

**Done when:** a buyer can add extras from the chat card or the cart, sees them on the
summary, and pays the combined total.

## Sprint A3 — Vendor app

**Goal:** vendors manage their own add-ons.

1. **Product form**: an *"Add-on"* switch with a hint — *"Sold only with a main item, e.g.
   drinks, extra protein."*
2. **Products list**: an *"Add-ons"* filter chip and an *Add-on* badge on those products.
3. **Orders**: add-ons already show as order lines; label them *Add-on* in order detail so
   the kitchen packs them with the meal.
4. **Onboarding nudge** (optional): on the dashboard, *"Add drinks and extras to sell more
   with every order"* until the vendor has at least one add-on.

**Done when:** a vendor can mark a product as an add-on, it disappears from search and
appears in the checkout offer for their customers.

## Sprint A4 — Admin and website (small)

1. **Admin order builder** (`OrderBuilder.tsx`): add-ons grouped under each vendor, with the
   same "needs a main item" rule.
2. **Admin vendor detail**: add-ons marked in the vendor's product list.
3. **Public store page** (`store/[slug]`): add-ons under an *"Extras"* heading, not as dishes.

## Rollout

1. Deploy A1 (backend + migration). Until A3 ships, admins can mark a few test products as
   add-ons through the API.
2. Deploy A2, then A3. Test end to end: vendor marks an add-on → buyer orders a dish → offered
   after Pay → pays the combined total → vendor sees the add-on on the order.
3. A4 when convenient.

## Risks and how we handle them

| Risk | Handling |
|---|---|
| Offer feels like friction | Once per cart, only when there is something to offer, and one tap to skip. |
| Buyer removes the meal but keeps the water | Cart removes orphaned add-ons; the server refuses them anyway. |
| Vendor marks a main dish as an add-on by mistake | It vanishes from search — the vendor app's Add-on badge makes it visible, and the switch is one tap to undo. |
| Price changes between offer and payment | The existing price re-check (`PRICE_CHANGED`) covers add-on lines like any other. |
