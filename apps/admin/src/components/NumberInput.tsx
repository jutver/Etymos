import { useEffect, useState, type InputHTMLAttributes } from "react";

type NumberInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
  value: number;
  onChange: (value: number) => void;
};

/**
 * A number box that can be cleared while typing.
 *
 * Binding `value={n}` with `onChange={(e) => set(Number(e.target.value))}`
 * snaps an emptied box straight back to "0" (Number("") is 0), so the 0 could
 * only be removed by typing after it and deleting it. This keeps what is typed
 * as text, reports blank as 0, and puts the 0 back only when the box loses
 * focus still empty.
 */
export function NumberInput({ value, onChange, onBlur, ...rest }: NumberInputProps) {
  const [text, setText] = useState(() => String(value));

  // Follow outside changes (data loading, a form reset) without overwriting
  // what is being typed when it already means the same number.
  useEffect(() => {
    setText((current) => (Number(current) === value ? current : String(value)));
  }, [value]);

  return (
    <input
      {...rest}
      type="number"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value === "" ? 0 : Number(e.target.value));
      }}
      onBlur={(e) => {
        if (text === "") setText(String(value));
        onBlur?.(e);
      }}
    />
  );
}
