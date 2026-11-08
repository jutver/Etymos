// A number whose digits roll to their new value like the wheels of a
// combination lock, e.g. a price switching between monthly and annual.
// Nothing snaps: every character sits in a slot whose width is measured and
// eased, so a digit that changes ("1" is narrower than "7"), a character
// that's added (its slot opens from nothing while its digit rolls up from 0)
// and one that's removed (its slot closes while it rolls down to 0) all
// glide. Screen readers get the plain text.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./RollingNumber.css";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
/** Matches the slot transition in RollingNumber.css. */
const SLOT_MS = 550;

interface Slot {
  key: string;
  char: string;
  /** False while the slot is opening or closing. */
  present: boolean;
}

const isDigit = (ch: string) => ch >= "0" && ch <= "9";

/** One slot per character, keyed by its place from the right, so the units
 * stay the same wheel when the number gets longer or shorter. */
function toSlots(value: string): Slot[] {
  const chars = [...value];
  return chars.map((char, i) => ({
    key: `${isDigit(char) ? "d" : "c"}${chars.length - i}`,
    char,
    present: true,
  }));
}

const place = (key: string) => Number(key.slice(1));

function DigitWheel({ digit, rollIn, delay }: { digit: number; rollIn: boolean; delay: number }) {
  // A wheel added after the first render starts at 0 and rolls to its digit.
  const [shown, setShown] = useState(rollIn ? 0 : digit);
  useEffect(() => {
    if (shown === digit) return;
    const frame = requestAnimationFrame(() => setShown(digit));
    return () => cancelAnimationFrame(frame);
  }, [digit, shown]);

  return (
    <span className="rolling-digit">
      {/* In the flow, invisible: gives the wheel its baseline. */}
      <span className="rolling-digit__sizer">{digit}</span>
      <span
        className="rolling-digit__strip"
        style={{ transform: `translateY(${-shown * 10}%)`, transitionDelay: `${delay}ms` }}
      >
        {DIGITS.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </span>
    </span>
  );
}

function SlotView({ slot, rollIn, delay }: { slot: Slot; rollIn: boolean; delay: number }) {
  // The character's natural width, measured off an invisible copy; the slot
  // eases to it (or to 0 while closing).
  const measure = useRef<HTMLSpanElement>(null);
  const [natural, setNatural] = useState<number>();
  useLayoutEffect(() => {
    const read = () => {
      const w = measure.current?.getBoundingClientRect().width;
      if (w) setNatural(w);
    };
    read();
    void document.fonts?.ready.then(read);
  }, [slot.char]);

  return (
    <span className="rolling-slot" data-present={slot.present} style={{ width: slot.present ? natural : 0 }}>
      <span ref={measure} className="rolling-measure">
        {slot.char}
      </span>
      {isDigit(slot.char) ? (
        <DigitWheel digit={Number(slot.char)} rollIn={rollIn} delay={delay} />
      ) : (
        <span className="rolling-char">{slot.char}</span>
      )}
    </span>
  );
}

export function RollingNumber({ value, className }: { value: string; className?: string }) {
  const [slots, setSlots] = useState<Slot[]>(() => toSlots(value));
  // Wheels present on the first render show their digit as is; only later
  // changes roll.
  const [settled, setSettled] = useState(false);
  useEffect(() => setSettled(true), []);

  const previous = useRef(value);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    const next = toSlots(value);
    const nextKeys = new Set(next.map((s) => s.key));
    const entering = new Set<string>();

    setSlots((current) => {
      const byKey = new Map(current.map((s) => [s.key, s]));
      const merged: Slot[] = next.map((s) => {
        if (byKey.has(s.key)) return s;
        entering.add(s.key);
        return { ...s, present: false };
      });
      // Characters the new number doesn't have close up; digits roll to 0.
      for (const s of current) {
        if (!nextKeys.has(s.key)) merged.push({ ...s, char: isDigit(s.char) ? "0" : s.char, present: false });
      }
      return merged.sort((a, b) => place(b.key) - place(a.key));
    });

    // Let new slots render closed for a frame, then open them.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() =>
        setSlots((current) => current.map((s) => (entering.has(s.key) ? { ...s, present: true } : s))),
      );
    });
    // Drop closed slots once they've finished closing.
    const cleanup = window.setTimeout(
      () => setSlots((current) => current.filter((s) => s.present || nextKeys.has(s.key))),
      SLOT_MS + 50,
    );
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(cleanup);
    };
  }, [value]);

  return (
    <span className={className}>
      <span className="sr-only">{value}</span>
      <span aria-hidden="true" className="rolling-number">
        {slots.map((slot, i) => (
          <SlotView key={slot.key} slot={slot} rollIn={settled} delay={(slots.length - 1 - i) * 30} />
        ))}
      </span>
    </span>
  );
}
