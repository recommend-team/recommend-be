# Chat — conversational commerce context

This folder is a **bounded context**, structured so it can be lifted into its own
repository and run as a service later. Extraction should be a move, not a rewrite.

## Boundary rules

1. **Nothing outside `src/chat/` imports from inside `src/chat/`** — except `AppModule`
   importing `ChatModule`.
2. **Only files in `src/chat/adapters/` may import from `src/modules/`.** Everything else
   talks to the platform through the interfaces in `src/chat/ports/`. Those ports are the
   future network boundary: when this becomes a service, only the adapters change
   (in-process call → HTTP client).
3. **The engine never knows which channel it is talking to.** Transports implement
   `ChannelAdapter`. The PWA is one; WhatsApp will be another. If engine code ever needs
   `if (channel === 'PWA')`, the interface is wrong — fix the interface.

## Layout

```
transport/      how messages get in and out
  pwa/          Socket.IO gateway + ChannelAdapter (live)
  whatsapp/     Cloud API adapter — lands when Meta approval does
conversation/   entities and persistence for conversations and messages
session/        the device-scoped token that owns a conversation
engine/         routes an inbound message to a flow or to discovery
ports/          interfaces onto the rest of the platform
adapters/       in-process implementations of those ports
```

## Why the money path will be scripted

When checkout arrives, `engine/flows/` will own everything leading to a charge — item
selection, contact capture, address, confirmation — as a deterministic state machine, so
no model output can invent a price, a quantity or an address. Discovery is where the LLM
runs, and its tools stay read-only.

## Identity

Buyers are **not** authenticated. A conversation is owned by a signed session token held
by the device — never by a phone number, because the number a buyer types is unverified
and typing someone else's must never surface their history.

Contact details accumulate in `Conversation.context.profile` as the assistant collects
them. A `users` row with `role = BUYER` is only minted at checkout, once name and phone
exist. When WhatsApp arrives it supplies a *verified* number, and on merge WhatsApp is
authoritative over anything captured here.

## Discovery and the price rule

`engine/discovery/` runs the model with four **read-only** tools. The worst a bad turn
can do is search for the wrong thing — nothing there can change state or spend money.

Prices reach the buyer through the structured payload only, never through model prose.
`price-guard.ts` enforces it: any amount in the text that no tool returned is treated as
invented, and the sentence carrying it is dropped. The failure this exists for is the
plausible one — the model adding two real prices and stating a total that is wrong by
the delivery fee.

**No `OPENAI_API_KEY` is a supported mode**, not a crash. Discovery falls back to keyword
search over the same catalogue, so the platform still returns real vendors and real
dishes. A model outage falls back the same way.

## Status

Built: session, persistence, Socket.IO transport, channel abstraction, LLM discovery
with catalogue tools and area resolution.
Not yet: checkout flow (B4), notifications and the payment return path (B5), WhatsApp
adapter (post-approval), response streaming (see the plan).
