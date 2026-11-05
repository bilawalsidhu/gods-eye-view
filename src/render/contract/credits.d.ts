/**
 * Attribution. The renderer reports every credit it owes (its own, each
 * base layer's, and per-tile credits as tiles load); Core renders the
 * credit DOM, so every renderer's credits look the same.
 */
import type { Off } from './common';

/** One credit, as plain data: Core renders and escapes it. */
export interface Credit {
  /** Plain text, never markup. */
  text: string;
  /** Where the credit links to. */
  href?: string;
  /** A logo drawn before the text. */
  logoUrl?: string;
  /** Shown on the map itself, rather than in the expanded list. */
  inline?: boolean;
}

export interface CreditsPort {
  /** Add a credit Core owes (a layer's source). */
  addStatic(credit: Credit): Off;
  /** Every credit owed now, in display order. */
  list(): Credit[];
  on(event: 'change', cb: (credits: Credit[]) => void): Off;
}
