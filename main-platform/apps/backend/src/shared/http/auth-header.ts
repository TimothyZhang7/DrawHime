export function readBearerToken(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) return undefined;
  if (!header) return undefined;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return undefined;
  const token = header.slice(prefix.length).trim();
  return token.length > 0 ? token : undefined;
}
