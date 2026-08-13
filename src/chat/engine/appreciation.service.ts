import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { enforcePriceIntegrity } from './discovery/price-guard';

export interface AppreciationRequest {
  buyerName: string;
  items: { name: string; quantity: number }[];
  vendorNames: string[];
}

/**
 * The thank-you a buyer gets when their order is complete.
 *
 * Written by the assistant rather than pulled from a template. A fixed string is the
 * opposite of warmth once you have read it twice, and a buyer on their fourth order has
 * read it three times — the one message in the whole flow that is not operational is
 * exactly the wrong place to sound like a receipt.
 *
 * Everything about this is designed to fail safely. It never blocks a completion, it
 * never invents a price, and if the model is unavailable the buyer still gets thanked.
 */
@Injectable()
export class AppreciationService {
  private readonly logger = new Logger(AppreciationService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('openai.apiKey');
    this.model =
      this.configService.get<string>('openai.model') ?? 'gpt-4o-mini';
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async write(request: AppreciationRequest): Promise<string> {
    const fallback = staticThanks(request.buyerName);
    if (!this.client) return fallback;

    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        // Higher than discovery's 0.2: the whole point is that it does not read the
        // same way twice, and there is no fact here to get wrong.
        temperature: 0.8,
        max_tokens: 90,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: describe(request) },
        ],
      });

      const text = completion.choices[0]?.message?.content?.trim();
      if (!text) return fallback;

      // The same guard discovery uses, with an empty allow-list — so *any* amount is
      // stripped. Nothing here has a price to quote, and a warm message that invents
      // one is worse than a dull message that does not.
      const guarded = enforcePriceIntegrity(text, []);
      if (guarded.violations.length > 0) {
        this.logger.warn(
          `Appreciation message mentioned ${guarded.violations.join(', ')} — stripped`,
        );
      }

      // Stripping works by dropping whole sentences, so a message that was nothing but
      // an invented price comes back empty. Say the plain thing instead.
      return guarded.text.trim() || fallback;
    } catch (error) {
      this.logger.warn(
        `Could not write an appreciation message, using the plain one: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return fallback;
    }
  }
}

const SYSTEM_PROMPT = `
You are Recommend, a warm Nigerian marketplace assistant. A buyer has just received
their order. Write them a short thank-you.

- Two sentences at most. Warm, human, never corporate.
- Use their first name once.
- You may mention what they bought, in their own words.
- Nigerian English is welcome.
- NEVER mention a price, a total, or any amount of money.
- NEVER say "enjoy your meal" or anything food-specific unless what they bought is
  clearly food. Vendors here sell gadgets, appliances and groceries too.
- Do not ask a question that needs answering, and do not invite a reply about the order.
- No markdown, no bullet points, no emoji spam — one emoji at most.
`.trim();

function describe(request: AppreciationRequest): string {
  const items = request.items
    .map((item) => `${item.quantity} × ${item.name}`)
    .join(', ');
  const vendors = request.vendorNames.join(', ');

  return [
    `Buyer: ${request.buyerName}`,
    items ? `They bought: ${items}` : null,
    vendors ? `From: ${vendors}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * What the buyer gets when the model is unavailable.
 *
 * Deliberately plain and deliberately vendor-neutral. This is what the feature degrades
 * *to*, not what it is.
 */
function staticThanks(buyerName: string): string {
  const first = buyerName?.trim().split(/\s+/)[0];
  return first
    ? `Thank you, ${first} — your order is complete. Whenever you need something else, I'm right here.`
    : "Thank you — your order is complete. Whenever you need something else, I'm right here.";
}
