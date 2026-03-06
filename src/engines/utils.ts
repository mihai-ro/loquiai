export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export function truncate(s: string, max = 300): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
