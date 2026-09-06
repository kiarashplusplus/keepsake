import * as React from "react";
import { Input } from "@/ui/Input";

export type SearchBarProps = {
  value: string;
  onChange: (q: string) => void;
  debounceMs?: number;
};

const DEFAULT_DEBOUNCE_MS = 300;

/** A single-line search field that only calls `onChange` `debounceMs` after
 * typing stops — and only when the debounced text actually differs from the
 * last value the parent gave us, so a round trip (parent echoes the same `q`
 * back via a prop update) never re-fires the same search. */
export function SearchBar({ value, onChange, debounceMs = DEFAULT_DEBOUNCE_MS }: SearchBarProps): React.ReactElement {
  const [text, setText] = React.useState(value);
  const latestExternalValue = React.useRef(value);
  const onChangeRef = React.useRef(onChange);

  React.useEffect(() => {
    latestExternalValue.current = value;
    onChangeRef.current = onChange;
  });

  // Re-derives `text` from a changed `value` prop during render rather than
  // in an effect (React's documented "adjusting state when a prop changes"
  // pattern) — an effect-based sync would set state synchronously inside the
  // effect body, which is exactly what this repo's stricter
  // `react-hooks/set-state-in-effect` lint rule (rightly) flags: it always
  // costs an extra render the render-time version doesn't.
  const [syncedValue, setSyncedValue] = React.useState(value);
  if (value !== syncedValue) {
    setSyncedValue(value);
    setText(value);
  }

  React.useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (text !== latestExternalValue.current) onChangeRef.current(text);
    }, debounceMs);
    return () => clearTimeout(timeoutId);
  }, [text, debounceMs]);

  return (
    <Input
      label="Search"
      value={text}
      onChangeText={setText}
      placeholder="Search keepsakes"
      returnKeyType="search"
    />
  );
}
