/**
 * A unique, URL-safe store link from a business name: "Mama Ngozi Kitchen" →
 * "mama-ngozi-kitchen", then "-2", "-3"… while `taken` says the link is in use.
 *
 * One rule for every place a vendor gets a link — at sign-up and when they first name the
 * business in Store details — so the two cannot drift apart.
 */
export async function uniqueSlug(
  businessName: string,
  taken: (slug: string) => Promise<boolean>,
): Promise<string> {
  const base =
    businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'store';

  let slug = base;
  let counter = 2;
  while (await taken(slug)) {
    slug = `${base}-${counter}`;
    counter++;
  }
  return slug;
}
