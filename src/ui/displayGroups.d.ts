/** A row of a group added to the Display panel. */
export type DisplayGroupRow =
  | {
      kind: 'toggle';
      id: string;
      label: string;
      icon?: string;
      title?: string;
      checked: boolean;
      onChange(checked: boolean): void;
    }
  | {
      kind: 'slider';
      id: string;
      label: string;
      min: number;
      max: number;
      /** Shown in percent. */
      value: number;
      onChange(value: number): void;
    }
  | { kind: 'note'; id: string; text: string };

/**
 * Show the group `id` on the page's Display panel, under Effects, in place
 * where it is shown already; null takes it away.
 */
export function publishDisplayGroup(
  id: string,
  group: { rows: DisplayGroupRow[] } | null,
): void;
