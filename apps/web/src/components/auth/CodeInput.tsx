import { t } from "../../lib/i18n";

/** Single field for a 6-digit emailed code: digits only, numeric keypad on
 * phones, and `one-time-code` so iOS/Android can autofill it from the email. */
export function CodeInput({
  value,
  onChange,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      aria-label={t("6-digit code")}
      maxLength={6}
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      placeholder="123456"
      className="w-full rounded-[var(--radius-control)] border border-line bg-white px-4 py-2.5 text-center text-lg font-semibold tracking-[0.4em] placeholder:tracking-normal placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
    />
  );
}
