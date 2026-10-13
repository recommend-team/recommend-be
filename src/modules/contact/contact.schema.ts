import { z } from 'zod';

/** Kept in step with the website's contact form (`recommend-fe` → `ContactContent.tsx`). */
export const CONTACT_TOPICS = [
  'Order or delivery',
  'Payment or withdrawal',
  'Vendor support',
  'Rider support',
  'Partnership or press',
  'Something else',
] as const;

export type ContactTopic = (typeof CONTACT_TOPICS)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => value || undefined);

export const contactSchema = z.object({
  fullName: z.string().trim().min(2, 'Please enter your name').max(100),
  email: z.string().trim().email('Enter a valid email').max(254),
  phoneNumber: optionalText(20).refine(
    (value) => !value || /^\+?[0-9\s-]{7,20}$/.test(value),
    'Enter a valid phone number',
  ),
  topic: z.enum(CONTACT_TOPICS),
  orderReference: optionalText(40),
  message: z
    .string()
    .trim()
    .min(10, 'A little more detail, please (10+ characters)')
    .max(2000, 'Please keep it under 2,000 characters'),
  /**
   * The honeypot. Hidden from people, so a human leaves it empty; form-filling bots fill
   * every field. Anything here and the message is quietly dropped.
   */
  website: z.string().optional(),
});

export type ContactMessage = z.infer<typeof contactSchema>;
