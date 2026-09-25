import { useState } from 'preact/hooks';

interface NumericInputProps {
  id?: string;
  class?: string;
  min?: number;
  max?: number;
  step?: number;
  value: number;
  onValueInput: (raw: string) => void;
}

/** Keep an unfinished edit visible without putting an empty string into numeric form data. */
export function NumericInput({ onValueInput, value, ...props }: NumericInputProps) {
  const [draft, setDraft] = useState<string | null>(null);

  return <input {...props} type="number" value={draft ?? value}
    onInput={event => {
      const raw = event.currentTarget.value;
      setDraft(raw);
      if (raw !== '') onValueInput(raw);
    }}
    onBlur={() => setDraft(null)} />;
}
