# Testing the order lifecycle in Postman

Buy through the customer app, then drive the order the rest of the way by hand.

Everything below assumes the backend on **`http://localhost:4000`** and the global prefix
**`/api/v1`**. Adjust `{{base}}` if your port differs.

---

## Set up a Postman environment

| Variable | Value |
|---|---|
| `base` | `http://localhost:4000/api/v1` |
| `reference` | *(filled in at step 1)* |
| `orderId` | *(filled in at step 3)* |
| `vendorToken` | *(filled in by the login request)* |
| `adminToken` | *(filled in by the login request)* |
| `paystackSecret` | your `PAYSTACK_SECRET_KEY` from `.env` — **only needed for Option B** |

---

## 1. Buy something in the customer app

Chat, add to cart, pay. When the bot returns the payment card, note the **reference** —
it looks like `REC-9A3F2B7C1D4E` and is shown on the card.

Put it in the `reference` environment variable.

You now have a checkout at `PENDING_PAYMENT`.

---

## 2. Mark it paid

Two ways. Pick based on whether you actually completed the Paystack sheet.

### Option A — you really paid with a test card *(simpler, no signature)*

If you went through Paystack's checkout with a test card, the payment is real as far as
Paystack is concerned, and the server can just ask.

```
POST {{base}}/checkout/{{reference}}/verify
```

No auth, no body, no headers.

**Expected — 200**

```json
{
  "success": true,
  "message": "Payment verified",
  "data": {
    "reference": "REC-9A3F2B7C1D4E",
    "status": "PAID",
    "paidAt": "2026-08-09T10:14:02.331Z",
    "goodsTotal": 3700,
    "deliveryFee": 1500,
    "totalAmount": 5200,
    "fulfillmentType": "DELIVERY",
    "vendors": [
      {
        "status": "PAID",
        "items": [{ "name": "Goat Meat Pepper Soup", "quantity": 1, "unitPrice": 3700 }]
      }
    ]
  }
}
```

> **If `status` comes back `PENDING_PAYMENT`**, Paystack has no successful charge for
> that reference — you abandoned the sheet. That is the endpoint working correctly; use
> Option B instead.

Paystack's test card, for reference: `4084 0840 8408 4081`, any future expiry, CVV `408`,
PIN `0000`, OTP `123456`.

### Option B — simulate the webhook *(no real payment needed)*

```
POST {{base}}/payments/webhook
Content-Type: application/json
```

Body:

```json
{
  "event": "charge.success",
  "data": { "reference": "{{reference}}", "status": "success" }
}
```

The request is rejected unless it carries a valid `x-paystack-signature`, so add this as
a **Pre-request Script** on the request:

```js
// Paystack signs the raw body with HMAC-SHA512. Resolve variables first — the signature
// must cover the exact bytes that go on the wire, not the template.
const raw = pm.variables.replaceIn(pm.request.body.raw);
const secret = pm.environment.get("paystackSecret");

pm.request.headers.upsert({
  key: "x-paystack-signature",
  value: CryptoJS.HmacSHA512(raw, secret).toString(CryptoJS.enc.Hex),
});
```

**Expected — 200**

```json
{
  "success": true,
  "message": "Request successful",
  "data": { "received": true }
}
```

**Either way**, within a second or two the buyer's chat receives:

> Payment confirmed — thank you! Your order of 1 item from Iya Basira Kitchen Oshodi has
> been sent through…

and each vendor gets a "New paid order" notification.

---

## 3. Log in

### Vendor

```
POST {{base}}/auth/login
Content-Type: application/json
```

```json
{ "email": "vendor@example.com", "password": "your-password" }
```

**Expected — 200**

```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "accessToken": "eyJhbGciOi…",
    "refreshToken": "eyJhbGciOi…",
    "user": { "id": "…", "email": "vendor@example.com", "role": "SELLER" }
  }
}
```

Add a **Tests** script so you never copy tokens by hand:

```js
pm.environment.set("vendorToken", pm.response.json().data.accessToken);
```

### Admin

Same request with your admin credentials, and:

```js
pm.environment.set("adminToken", pm.response.json().data.accessToken);
```

---

## 4. Vendor: mark ready for pickup

First find the vendor's own order id — the checkout splits into one order per vendor:

```
GET {{base}}/sellers/orders?status=PAID
Authorization: Bearer {{vendorToken}}
```

Take `data.items[0].id` and put it in `orderId`. Then:

```
PATCH {{base}}/sellers/orders/{{orderId}}/ready
Authorization: Bearer {{vendorToken}}
```

No body.

**Expected — 200**

```json
{
  "success": true,
  "message": "Order marked ready for pickup",
  "data": null
}
```

**Repeat for every vendor on the basket.** The checkout only becomes `READY` once the
*last* one is ready — that is deliberate, so the buyer is never told the order has moved
while half of it is still being made.

**On a pickup order**, the buyer is messaged the moment the checkout turns `READY`:

> Your order is ready for collection.

**On a delivery order**, they hear nothing yet.

### Errors you may see

| Status | Meaning |
|---|---|
| `400` | The order is not `PAID` — check step 2 actually worked |
| `403` | `That order belongs to another vendor` — wrong token for that order |
| `404` | Wrong `orderId`. Note this is the **order** id, not the checkout reference |

---

## 5. Admin: dispatch

Only for **delivery** orders, and only once every vendor is ready. Means "a rider has
collected everything and left".

```
POST {{base}}/admin/transactions/{{reference}}/dispatch
Authorization: Bearer {{adminToken}}
```

No body.

**Expected — 200**, with the whole transaction back:

```json
{
  "success": true,
  "message": "Request successful",
  "data": {
    "reference": "REC-9A3F2B7C1D4E",
    "status": "DISPATCHED",
    "buyerName": "Chinwe Obi",
    "totalAmount": 5200,
    "vendors": [{ "vendorName": "Iya Basira Kitchen Oshodi", "status": "READY", "items": [] }]
  }
}
```

The buyer gets their one message:

> Your order is on its way.

| Status | Meaning |
|---|---|
| `400` | `Every vendor must be ready before dispatch` — go back to step 4 |
| `400` | `A pickup order is never dispatched` — skip to step 6 |

---

## 6. Complete the order

Normally the buyer taps **"I've received this"** in their Orders tab, or the rider
closes it. Admin can stand in:

```
POST {{base}}/admin/transactions/{{reference}}/complete
Authorization: Bearer {{adminToken}}
```

No body.

**Expected — 200**, `data.status` is `COMPLETED`, and **every vendor order is
`COMPLETED` too** — payout reporting reads the vendor order, not the checkout, so the two
must agree.

The buyer gets a thank-you the assistant writes for that order:

> Thank you so much, Chinwe! We're glad you received your Goat Meat Pepper Soup from Iya
> Basira Kitchen — hope it warms your heart! 😊

It differs every time. If OpenAI is unreachable it falls back to a plain sentence rather
than failing.

---

## 7. Extras

### Force any status (the escape hatch)

```
PATCH {{base}}/admin/transactions/{{reference}}/status
Authorization: Bearer {{adminToken}}
Content-Type: application/json
```

```json
{ "status": "CANCELLED", "note": "Vendor closed, refunding by hand" }
```

Ignores the transition rules on purpose — it is for orders the rules have stranded.
Every use is recorded against your admin account, so `note` is worth filling in.

### See who moved what

```
GET {{base}}/admin/transactions/{{reference}}/history
Authorization: Bearer {{adminToken}}
```

**Expected — 200**

```json
{
  "success": true,
  "data": [
    { "orderId": "…", "fromStatus": "PAID", "toStatus": "READY", "actorType": "VENDOR" },
    { "orderId": null, "fromStatus": "PAID", "toStatus": "READY", "actorType": "SYSTEM" },
    { "orderId": null, "fromStatus": "READY", "toStatus": "DISPATCHED", "actorType": "ADMIN" },
    { "orderId": null, "fromStatus": "DISPATCHED", "toStatus": "COMPLETED", "actorType": "RIDER" }
  ]
}
```

`orderId` set means one vendor's order moved; `null` means the whole checkout did.
`SYSTEM` means nobody pressed anything — the checkout followed its vendors.

### Find a reference you have lost

```
GET {{base}}/admin/transactions?status=PAID&search=Chinwe
Authorization: Bearer {{adminToken}}
```

Searches reference, buyer name and phone.

---

## What the buyer sees, in full

Exactly three messages after checkout. Everything else happens silently.

| When | Message |
|---|---|
| Payment confirmed | "Payment confirmed — thank you! Your order of…" |
| Dispatched *(delivery)* or ready *(pickup)* | "Your order is on its way." / "Your order is ready for collection." |
| Completed | A thank-you written for that order, by name |

Vendors marking ready produces **nothing** for the buyer unless it was the last one, and
even then only on a pickup order. That restraint is the design, not an omission.
