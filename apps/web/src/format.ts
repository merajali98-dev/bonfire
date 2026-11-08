const EMBER = 10n ** 18n;
const NEAR = 10n ** 24n;

function decimal(value: bigint, unit: bigint, places: number): string {
  const scale = 10n ** BigInt(places);
  const scaled = (value * scale) / unit;
  const whole = (scaled / scale).toLocaleString("en-US");
  const fraction = (scaled % scale).toString().padStart(places, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export const showEmber = (value: string | bigint) => decimal(BigInt(value), EMBER, 2);
export const showNear = (value: string | bigint) => decimal(BigInt(value), NEAR, 3);

/** Parses what someone typed into EMBER smallest units, or null if it isn't a positive amount. */
export function parseEmber(text: string): bigint | null {
  const match = text.trim().match(/^(\d*)(?:\.(\d{0,18}))?$/);
  if (!match || (!match[1] && !match[2])) return null;
  const amount = BigInt(match[1] || "0") * EMBER + BigInt((match[2] ?? "").padEnd(18, "0") || "0");
  return amount > 0n ? amount : null;
}

export function countdown(ms: number): string {
  if (ms <= 0) return "now";
  const total = Math.ceil(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export const shortAccount = (id: string) => (id.length > 26 ? `${id.slice(0, 12)}…${id.slice(-11)}` : id);
