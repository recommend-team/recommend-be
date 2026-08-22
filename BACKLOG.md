# Recommend — Backlog

What is left, why it matters, and what has to be decided before it can be built.

Companion to `MVP_IMPLEMENTATION_PLAN.md`, which describes what was *agreed*. This file
describes what is *outstanding*. Everything here was found while building; nothing is
speculative unless it says so.

**Status key** — 🔴 wrong today · 🟠 missing · 🟡 rough edge · ⚪ decision needed

---

## 1. Before the MVP is pilot-ready

### 1.1 🔴 Order lifecycle — nothing can advance an order past `PAID`

The largest hole. `GET /sellers/orders` is read-only, and while `PROCESSING` and
`COMPLETED` exist in `OrderStatus`, nothing in the codebase ever writes them — they
appear only in stats filters (`admin.service.ts`). Verified by search across all modules.

In a pilot this means: the buyer pays, the vendor is notified, the vendor cooks the food,
and the order reads "Paid" forever. Nobody can mark it ready or delivered, and the buyer
has no way to learn any of it. The current behaviour is *wrong*, not merely absent, which
is why this ranks above everything else here.

**This is also the contract the vendor app (§6.2) is built against, so it comes first.**
Driving it from the existing web dashboard proves the states before any native screen
is designed around them.

#### Two layers

**One rider collects from every vendor and delivers one parcel.** That is the fact the
whole design follows from: the buyer's order is one physical thing, so vendor A accepting
while vendor B has not is not a fact about the buyer's order at all.

**Per-vendor — operational, for vendors and dispatch.** Answers one question: can the
rider collect from this vendor yet?

```
PAID → READY
```

One transition, and it is all a vendor needs. There is deliberately no separate "accept"
step: *accepted* was defined as "the vendor has the product and the rider can come",
which is the same event as *ready*, and two states for one event is how they drift apart.

**Label it "Ready for pickup", never "Accept".** A button marked Accept gets tapped the
moment an order appears — that is what accepting means everywhere else — and dispatch
sends a rider for food that is not cooked. The label, not the state name, is what decides
whether the data means anything.

What this gives up: knowing whether a vendor has *seen* an order, so "cooking" and
"asleep" look identical and dispatch has to phone to tell them apart. Accepted
deliberately — a state vendors tap reflexively is worse than no state — and an
acknowledgement can be added later without touching anything the buyer sees.

**Per-checkout — derived from the least-advanced vendor order**, and the only layer the
buyer ever sees:

```
PAID → READY      (every vendor ready)
     → DISPATCHED (rider has collected everything and left)
     → COMPLETED  (buyer, or admin/dispatch — never automatic)
```

Deriving from the *slowest* vendor makes half-finished states structurally invisible to
the buyer, rather than something the messaging has to remember to hide.

#### Who moves what

| Actor | Transitions |
|---|---|
| Vendor | `READY` — their own orders only |
| Dispatch rider | `COMPLETED` — the order they carried, and nothing else |
| Buyer | `COMPLETED` — one button, for the whole order |
| Admin | `DISPATCHED`, and any state to any state as an override |

`DISPATCHED` is **not** a vendor's to mark. With one rider carrying everything, no single
vendor knows collection has finished; that is a checkout-level fact belonging to whoever
assigns the rider. It means "handed over", not "GPS says it is moving", and no wording
shown to a buyer should imply otherwise.

The rider's only power is to close the order they delivered — the person who physically
handed the goods over is the one who knows it happened. Everything else is admin's.

**Overrides are admin's alone.** Any state to any state, audited, and available to nobody
else: it is the tool for unsticking a stalled order, and in anyone else's hands it is a
way to quietly rewrite what happened.

**Rider actions fall to admin until riders are real.** There is no rider app and no
assignment in the system — `Role.RIDER` exists with a KYC flow and nothing else — so
until then admin closes deliveries on riders' behalf.

Admin's any-to-any freedom is deliberate: vendors forget, and someone has to unstick an
order. It needs **an audit trail** — who changed what, when — because a disputed order
with no history is unarguable, and reconstructing one later is far more expensive than
recording it now.

#### What the buyer actually sees: one message

Every message pushes their conversation up the screen, and a running commentary on
someone else's workflow is noise. After the payment confirmation the buyer gets exactly
one more thing:

| Fulfillment | The single message | Fired on |
|---|---|---|
| Delivery | "Your order is on its way" | `DISPATCHED` |
| Pickup | "Your order is ready for collection" | `READY` |

Pickup has no dispatch, so its one message fires earlier — and it is the only one that
matters there, being the cue to leave the house.

**Then one closing message on `COMPLETED`**, warm, using the buyer's first name, and
**written by the assistant rather than a template**. Not a fourth status update: the
transaction is over, and it is the one moment worth spending a message on that is not
operational. Where the buyer completed the order themselves it reads as a reply to
something they did rather than an interruption.

A fixed string would be the wrong thing here — the same eleven words arriving after every
order is the opposite of warmth, and a buyer on their fourth order has read it three
times. The assistant already has the voice; give it the buyer's name and what they
bought, and let it write.

Constraints, none of them optional:

- **Vendor-neutral.** "Enjoy your meal" is wrong for a power bank — the same trap as
  "being prepared".
- **No prices.** Run the output through `enforcePriceIntegrity` with an empty allow-list,
  so any figure the model invents is stripped rather than sent.
- **A static fallback.** No API key, a model outage, a timeout — the buyer still gets
  thanked. The fallback is the boring template; it is what the feature degrades *to*,
  not what it is.
- **One call, no tools.** Nothing here needs the catalogue.

**No "being prepared" message.** Two reasons, and the second is the stronger: it is food
language in a catalogue that sells gadgets, appliances and phone accessories — nobody
prepares a power bank — and it can simply be false, since an item already on a shelf is
ready the moment the order lands. The same rule is already written into
`payment-confirmation.listener.ts`: *"'on its way to the kitchen' would be wrong for most
of them"*.

The internal states are unaffected. Vendors still move `ACCEPTED → READY` and the derived
checkout status still exists for the admin view; those states simply stop being a reason
to message anyone. Fewer notifications, not less information.

Messages post into the buyer's conversation through `ChannelRegistry`, the same path the
payment confirmation uses — so WhatsApp inherits the whole lifecycle when Meta approves.

**Open questions (⚪)**

1. **Is `ACCEPTED` real?** Does a buka meaningfully confirm before cooking, or does paid
   effectively mean started? A status vendors ignore is worse than no status.
2. **Can a vendor decline?** See §1.6 — this is the unresolved one.
3. **Auto-complete?** See §1.2.

### 1.2 🟠 The buyer's Orders tab

`BottomNav` renders Orders as a disabled tab. A buyer's only record of a purchase is
scrolling back through the conversation. `GET /checkout/:reference` already returns a
single order; there is no list endpoint and no screen.

This is also where the buyer marks an order **complete**, which is the one transition
they own.

**It shows orders placed from this browser, not "all their orders".** The session token
is the identity and there is no login, so clearing the browser or switching from phone to
laptop empties the list. Tolerable today because the chat thread hides the limitation; an
Orders tab makes it visible and someone will ask. Either the copy is honest about it
(§1.5) or it eventually needs a "find my orders" flow by phone number — which is
authentication, and a larger decision.

**Settled:** one Complete button for the whole order, not one per vendor. One rider
means one delivery means one confirmation.

**Settled: no auto-complete.** A timer marking orders delivered would manufacture a
record of deliveries that may never have happened — and that record is exactly what
payouts key off, so a false completion is worse than a stale one. `COMPLETED` is set by
the buyer or by admin/dispatch, whoever gets there first, with the audit trail recording
which.

**The accepted cost:** some orders will sit at `DISPATCHED` indefinitely, because the
buyer forgets and the rider does not report back. Someone has to chase those before
vendors are paid out. That is real operational work and it is the deliberate price of
never fabricating a completion.

### 1.3 🔴 The landing page still sells WhatsApp

`recommend-fe` tells buyers to search WhatsApp for a bot Meta has not approved. Not a
stray line — it is the pitch:

| File | Copy |
|---|---|
| `HowToOrder.tsx` | "Open whatsapp, and search for Recommend. then tap on the chat" |
| `FaqSection.tsx` | "…all through WhatsApp. No app needed." / "Send 'Hey Recommend' to our WhatsApp number" |
| `AboutValuesSection.tsx` | "No app. No forms. No fees. Just WhatsApp…" |
| `FooterSection.tsx` | "Anything you need, delivered right on WhatsApp." |
| `FounderStorySection.tsx` | "WHAT IF WHATSAPP COULD JUST FIX THIS?" |

The "no app needed" framing survives the move to a PWA — that is genuinely true of an
installable web app, and is a strength rather than a compromise.

**Decision needed (⚪):** the WhatsApp iconography on the CTA buttons. "Start Ordering"
now opens the customer app while showing a WhatsApp mark. Keep it as "coming soon",
or remove it until Meta approves? This is positioning, so it is the founder's call.

### 1.4 🟡 Price drift arrives as prose

When a price changes between adding to cart and paying, `checkout.flow.ts` explains it in
words. F3 called for a card showing old versus new so the buyer can see exactly what
changed before deciding. Rare, but it happens at the worst possible moment.

### 1.5 🟠 Settings tab, and honesty about device-scoped history

Also a disabled tab. At minimum it needs to say plainly that history lives on this device
and disappears if the browser is cleared — there is no login, and the phone number the
buyer typed is unverified, so nothing can be recovered. Saying so quietly up front is
better than a support conversation later.

### 1.6 🔴 A vendor cannot decline an order — agreed in principle, deferred

The money is already taken when a vendor sees the order. A buka closes, an item is gone,
a phone was sold an hour ago — and there is no path for the vendor to say so. Refunds are
explicitly out of MVP scope (`MVP_IMPLEMENTATION_PLAN.md` §8), which means today the
buyer is simply out of pocket with no recourse in the product.

**Agreed: vendors will be able to decline. Deliberately not built yet** — the flow around
it still needs thought, and half a refund path is worse than none.

The shape it will most likely take: declining cancels **that vendor's** order only, the
rider still collects the rest, and the buyer is messaged, because their money is
involved. It surfaces on the admin transactions view as *refund owed*, settled by hand
through Paystack and recorded in the app. Manual is acceptable at pilot volume; silent is
not.

What still needs deciding: whether a partial basket should be delivered at all when the
declined item was the point of the order; whether the buyer can choose a refund of the
whole thing; whether the delivery fee is refunded on a partial cancellation; and who
carries the loss if the rider has already collected from the other vendor.

**Until it exists, declines happen by phone** and are recorded by admin as an override —
which is exactly the kind of gap an audit trail makes visible rather than invisible.

---

## 2. Known bugs, not yet fixed

### 2.1 🔴 Vendor profile cannot save service areas

`recommend-fe`'s vendor dashboard (`vendor/dashboard/store/page.tsx`) sends
`businessAreas` as a comma-joined string. The API has taken `areaIds` (UUIDs) since B1
(`update-profile.dto.ts`). The storefront page reads `vendor.businessAreas` too.

Found by reading both sides; **not runtime-verified**. Likely a 400 on save, or areas
silently dropped. Either way a vendor cannot currently set where they deliver.

### 2.2 🟡 Storefront pages have no link previews

`store/[slug]/page.tsx` is `"use client"` with no `generateMetadata`, so a vendor sharing
their storefront link gets a bare URL with no title, image or description. Matters as
soon as vendors start sharing links, which is a cheap growth channel. Fixing it means
splitting the page into a server component wrapper — see also §10.4 of the plan.

### 2.3 🟡 The assistant lists vendors in its text

The prompt forbids it — the cards already show them — but the model still writes
"- Ola's Kitchen\n- Mama Put Delight…" above the cards. Cosmetic duplication.

### 2.4 🟡 "and in Lekki?" returns two areas at once

Asked about a second area, the model searches both and the results merge, so Egbeda and
Lekki vendors appear together. Arguably right for "and", noisy for "actually, Lekki".
Needs a decision about what that phrasing means before it can be called a bug.

### 2.5 🟡 Every visitor creates a conversation, including bounces

Opening the customer app is enough: `initialise` mints a session, `findOrCreate` inserts
a `conversations` row, and the greeting inserts a `chat_messages` row — before the buyer
types anything. Bots, crawlers and people who leave immediately all leave a thread
behind, and nothing prunes them.

Invisible at pilot volume. At scale it is junk, and it will quietly inflate any
"conversations" metric you look at.

The fix is to defer the row until the buyer actually says something — but the greeting
currently needs a conversation to live in, so it needs a little thought rather than a
quick edit.

### 2.6 🟡 Dead CTAs remain for vendors and riders

"Become a Rider" and "Join as a Business" (`CaricatureBottom`,
`MobileOnlyCaricatureSection`) still have no `href`. The buyer-facing CTAs were wired to
`NEXT_PUBLIC_CUSTOMER_APP_URL`; these were left alone deliberately, since they belong to
signup flows rather than the customer app.

---

### 2.7 🔴 The customer app has no tests at all

No vitest, no jest, no testing-library — `package.json` has `dev`, `build`, `preview`,
`lint`, `format`, `typecheck` and nothing else. The backend has 201 tests. The app buyers
actually touch, and the only one handling a cart and a payment, has none.

This is not theoretical. Two bugs shipped and were caught by hand within an hour of each
other, both trivially catchable:

- **The Add button did nothing.** An effect meant to clear the cart when a payment landed
  had `itemCount` in its dependency chain, so adding an item re-ran it and emptied the
  cart in the same tick. Only appeared in threads that had already paid for something.
- **The Orders tab spun forever.** `connect()` replaces the whole handler object, and
  React runs child effects before the parent's — so the orders listener registered and
  was wiped a moment later. The server answered correctly; nobody was listening.

Both are ordinary logic, testable without a browser. Neither would have survived a test.

**Suggested:** vitest plus `@testing-library/react`, and start with the pieces where
being wrong costs money — the cart store, `useOrders`, `PaymentLinkCard`'s phase
machine, and the `paidReferences` rule that broke the cart.

---

## 3. Deferred decisions

### 3.1 ⚪ `DELIVERY_FEE_NGN`

Still unset, so the platform runs on the ₦1,500 default — and whatever the value is at
deploy time is snapshotted onto every order placed. Worth choosing deliberately rather
than discovering it in a pilot.

### 3.2 ⚪ Do vendors need the buyer's phone number?

Vendors do not call customers — riders do. But `Order` denormalises `buyerName`,
`buyerPhone` and `deliveryAddress` per vendor, and the order notification includes them.
A pickup order may genuinely warrant contact; a delivery order may not. Narrowing this is
a privacy improvement with a real trade-off.

The checkout wording was already corrected: it now asks "What number can we reach you on
about the order?" rather than naming the vendor.

### 3.3 ⚪ When to collect buyer details

Currently collected at checkout, discovered opportunistically. Raised earlier and
deliberately deferred — worth revisiting once pilot data shows where buyers drop out.

### 3.4 ⚪ Install prompt: permanent dismissal

Tapping × on "Keep Recommend on your phone" hides it forever
(`localStorage: recommend.install.dismissed`). Backing out of the browser's own dialog
does *not* count as a refusal and the prompt returns. If a monthly re-ask is preferred,
that is a one-line change in `lib/install.ts`.

---

## 4. Known-weak, working for now

### 4.1 Product taxonomy — the synonym map is an interim

`discovery/synonyms.ts` maps buyer words to business categories, so "food" finds
restaurants and "air conditioner" finds split units. It is a hand-maintained list in one
file: it will drift as the catalogue grows and knows nothing about a category added next
month.

The durable answer is an **admin-managed product-type taxonomy with central synonyms** —
the same decision taken for areas, for the same reason. Free-text keywords per vendor
invite stuffing and inconsistent spelling; a central list does not. Until then, the map
is honest about what it is.

### 4.2 Payment reconciliation is now three-way, and that is deliberate

Webhook, buyer's app, and a scheduled sweep. Documented here only so nobody later
removes one as redundant — each covers a case the others cannot. The sweep
(`payment-reconciliation.service.ts`) is the only one that needs nobody present.

---

## 5. Before hosting is paid for

Nothing below has ever run outside a development machine.

- [ ] `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_CUSTOMER_APP_URL` set for `recommend-fe`
      (see its `.env.example`) — the build fails without the first
- [ ] `VITE_API_BASE_URL` and `VITE_SOCKET_URL` set for the customer app
- [ ] A domain for the customer app; the PWA manifest `start_url` should match it
- [ ] `DELIVERY_FEE_NGN` decided (§3.1)
- [ ] Paystack webhook pointed at the public URL — and confirmed delivered, which
      finally answers whether the 93-minute delay seen locally was retries or an
      unreachable server
- [ ] Upstash reachable from the host, and Socket.IO clustering confirmed across
      instances
- [ ] CORS allowlist includes the live frontend origins (`src/config/cors.ts`)
- [ ] Migrations run against the production database
- [ ] The sweep confirmed running on a real scheduler
- [ ] Install prompt tested over HTTPS on an actual phone, iOS included

---

## 6. Planned after the MVP

### 6.1 Wallets for vendors and riders

Today `Order.vendorAmount` records what a vendor is owed and nothing else happens —
payouts are worked out and paid by hand. A wallet replaces that with balances the vendor
and rider can see, and a withdrawal they can request.

This is a larger change than it sounds, and worth naming why before it is scoped:

- **A ledger, not a balance column.** A single `balance` field that gets incremented is
  the classic way to lose money: one double-processed webhook, one retried request, and
  the number is wrong with no way to find out where. Model it as immutable entries —
  order paid, commission taken, withdrawal requested, withdrawal settled, refund
  reversed — and derive the balance by summing them. Then a wrong balance is always
  explainable, and always repairable.
- **Every entry needs an idempotency key.** The same `checkout.paid` event can arrive
  twice (webhook retry, sweep, admin verify all lead to the same place); crediting twice
  must be impossible by construction rather than by hoping.
- **Money leaving needs a real flow.** `PaymentsService` has `initializePayment` and
  nothing else — there is no Paystack transfer, no recipient code, no bank account
  verification. Withdrawals mean building all of it, plus a state machine of its own
  (requested → approved → sent → settled/failed) and an admin approval step.
- **Riders are not modelled yet** beyond a `RIDER` role and a KYC flow. Earnings imply
  dispatch, which implies assignment — none of which exists.
- **When does money become withdrawable?** Almost certainly on `COMPLETED` (§1.1), which
  is exactly why the auto-complete question in §1.2 is a financial decision and not a
  UI one.

**Admin transaction history** — a full ledger view, filterable by vendor, rider and
period. `GET /admin/transactions` already gives one row per *payment*; this is the
other half, one row per *movement of money*, including commissions and withdrawals.

### 6.2 Vendor app (`recommend_vendors`, React Native)

A native app for vendors, replacing the web dashboard as their primary surface.

**Built against §1.1, which is why the lifecycle comes first.** The app should consume
the same endpoints the web dashboard uses — no vendor-app-only API — so behaviour cannot
drift between the two. Push notifications matter more here than anywhere else in the
product: a vendor who misses an order is a buyer who paid for nothing.

---

## 7. Explicitly out of scope for MVP

Unchanged from `MVP_IMPLEMENTATION_PLAN.md` §8 — recorded here so they are not mistaken
for oversights: the WhatsApp channel (the adapter seam exists, the adapter does not),
rider dispatch, SMS, real geolocation, buyer accounts, automated vendor payouts, refunds
and cancellations, and vendor-to-buyer live chat.
