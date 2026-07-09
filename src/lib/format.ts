export function formatVND(amount: number): string {
  return new Intl.NumberFormat("vi-VN").format(amount) + " đ";
}

export function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function annualSavingsPercent(priceMonthly: number, priceAnnual: number): number {
  if (priceMonthly <= 0) return 0;
  return Math.round((1 - priceAnnual / (priceMonthly * 12)) * 100);
}
