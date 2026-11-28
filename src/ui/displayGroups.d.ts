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

/** A choice over the map, added under Map Source. */
export type MapLayerRow = {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
};

/**
 * Show the map layer `id` under Map Source as `row` describes it, in place
 * where it is shown already; null takes it away.
 */
export function publishMapLayer(id: string, row: MapLayerRow | null): void;
