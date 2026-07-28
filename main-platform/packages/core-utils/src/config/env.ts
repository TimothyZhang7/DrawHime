export function readStringEnv(name: string, fallback?: string): string {
  const value = process.env[name];
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

export function readPortEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid port in environment variable ${name}`);
  }
  return value;
}
