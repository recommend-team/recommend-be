/**
 * Personal data never goes into the logs whole. Enough is kept to tell entries apart and
 * to follow up a problem — "ad***@gmail.com", "102.89.34.x" — and no more.
 */

/** "ada.obi@gmail.com" → "ad***@gmail.com". */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '(no email)';
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

/** "102.89.34.17" → "102.89.34.x"; an IPv6 address keeps its first four groups. */
export function maskIp(ip: string | null | undefined): string {
  if (!ip) return 'unknown';
  if (ip.includes('.')) return ip.replace(/\.\d+$/, '.x');
  return `${ip.split(':').slice(0, 4).join(':')}:…`;
}
