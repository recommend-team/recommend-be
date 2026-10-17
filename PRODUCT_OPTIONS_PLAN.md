# Dishes built the way restaurants sell them — portions, extras and required choices

**Status: all four stages built 2026-10-17/18 — backend, vendor app, customer app + storefront (with packs through the chat checkout), chat assistant + admin panel.**

## Goal

Restaurants sell **portions with extras**, not fixed plates. A vendor should be able to say:

> **Rice and beans** — ₦1,000 per portion
> Extras: Beef ₦1,000 · Takeaway pack ₦200 · Water ₦300 · Nylon ₦100
> **Rice and stew** — ₦1,500 per portion — *Choose your protein (required, pick 1): Chicken · Beef · Fish +₦300*

…and a customer builds exactly what they want — 5 portions, 4 beef, 3 water — then repeats
that pack (×2), and can change any of it in the cart before paying.

Works for any product, not only food: a gadget seller simply uses no extras or choices.

## Decided 

| Question | Decision |
|---|---|
| Where extras live | **One extras list per vendor** (create "Takeaway ₦200" once), and **on each dish the vendor ticks which extras go with it**. |
| Existing extras | Attached to **all** of that vendor's dishes when this ships, so nothing disappears; vendors untick what doesn't fit. |
| Extras vs portions | **Independent** — the customer picks each quantity. |
| Limit per extra | **At most 5 of each extra per pack.** |
| Packs | A built dish is a **pack**. The customer can repeat an identical pack: "A — 5 portions, 4 meat, 3 water **×2**". Each pack is packed separately. |
| Editing | Before checkout the customer can open a pack and change anything, change the number of packs, remove it, or add the same dish again with different extras (a separate line). |
| Required choices | **Included.** The vendor can add a choice to a dish ("Choose your protein"), mark it **required or optional**, say how many to pick, and give each option an extra cost (₦0 allowed). |

## Words used here

- **Dish / product** — what the vendor sells, with a price **per unit** (portion, plate, piece…).
- **Extra** — from the vendor's extras list, ticked onto dishes. Optional, 0–5 per pack, its own price.
- **Choice** — belongs to one dish: a question with options ("Choose your protein: Chicken / Beef / Fish"). Required or optional; "pick exactly 1", "up to 2", etc. Options can cost extra.
- **Pack** — one built dish: portions + extras + choices. Can be repeated ×N.

## What exists to build on

- Extras already exist: products marked `isAddOn`, vendor-wide, sold only with a main from the
  same vendor, offered at checkout and in the chat. **What's missing:** which extras belong to
  which dish, keeping extras with their dish in an order, units, choices, and packs.
- Orders store one row per item (`order_items`), extras as separate rows with no link to a dish.

## Data (backend)

| Change | Purpose |
|---|---|
| `products.unit` (new, optional) | "portion", "plate", "piece", "pack", "wrap", "bottle" — shown as "₦1,000 per portion". Empty shows no unit. |
| New table `product_extras` (dish ↔ extra) | Which extras are ticked on which dish. |
| New table `product_choice_groups` | A dish's choices: name, required or not, min / max to pick, display order. |
| New table `product_choice_options` | A choice's options: name, extra cost (₦0 allowed), available or not, display order. |
| `order_items`: new `packs` and `parentItemId` | The dish row records portions **per pack** and the number of packs; its extras point back to it, so an order reads "Rice and beans — 5 portions ×2, with Beef ×4, Water ×3". |
| New table `order_item_choices` | What was chosen, copied at order time (name and cost), so later edits to the menu never change a past order. |

Prices are always worked out on the server, as today: (portions × price + extras + choice costs)
× packs. A price changed since the customer added it is shown before paying, as today.

**Limits:** up to **10 portions per pack**, **5 of each extra per pack**, **50 packs** per line
(today's ceiling).

**Old apps keep working during the rollout:** a checkout sent the old way (flat items) is still
accepted; extras sent that way are attached to the vendor's first dish in the order.

## Each surface

### Vendor app
- **Extras** (new screen in the menu): add, edit, remove, mark unavailable — Beef, Takeaway, Water, Nylon.
- **Product form:**
  - Unit ("per portion ▾").
  - **Extras** — tick which of your extras go with this dish.
  - **+ Add a choice** — name, Required yes/no, "customer picks exactly / up to N", options with extra cost; edit, reorder, delete; mark an option unavailable (out of fish today).
- **Orders:** each pack shown whole — portions, packs, extras and choices — so the kitchen packs it right.

### Customer app and storefront (website)
- Tapping a dish opens **"build your pack"**: portions stepper, required choices (marked
  *Required*, Add button disabled until answered), optional choices, extras with steppers (max 5),
  live total, **Add to cart**.
- **Cart:** each pack as one line with its contents; open to edit, change ×N, remove; the same
  dish with different extras is a separate line.
- Receipts, the order page and "my orders" show packs the same way.

### Chat assistant
- After a buyer picks a dish: asks any **required** choice ("Which protein — chicken, beef or
  fish (+₦300)?"), then offers **that dish's** extras (today it offers all of the vendor's).
- The order summary card shows packs whole.

### Admin panel
- Vendor **Products** tab: the same unit / extras / choices fields, and an **Extras** list.
- The **order builder** in conversations builds packs the same way.
- Transactions, order details and the vendor's order emails show packs whole.

## Choices and several portions (decided)

**One choice per pack.** 5 portions of Rice and stew with "Choose your protein: pick 1" means
all 5 portions get the protein chosen. A customer who wants mixed proteins adds a second pack.
An option's extra cost (Fish +₦300) is **per portion** — 5 portions of fish cost ₦1,500 more —
so it should be shown to buyers as "+₦300 per portion".

## Stages (one at a time, each approved before the next)

1. **Backend** — the data above, migration (existing extras attached to all of each vendor's
   dishes), product APIs for units / extras / choices (vendor and admin), checkout and orders with
   packs (old format still accepted), order views and emails; tests and a run on the test DB.
2. **Vendor app** — Extras screen, product form (unit, extras, choices), packs in orders.
3. **Customer app + storefront** — build-your-pack sheet, cart editing, checkout, receipts and order pages.
4. **Chat assistant + admin panel** — dish-specific extras and required choices in the chat; admin
   products tab, order builder, transactions.

## Not changing

- Products without extras or choices (gadgets, drinks) work exactly as today.
- Money: payouts, commission, delivery fee.
- How extras are priced — still their own price, set once by the vendor.
