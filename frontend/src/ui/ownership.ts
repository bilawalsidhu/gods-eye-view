/**
 * The ownership spine on the aircraft card: who the register says owns an airframe, which filing
 * entity that resolved to, and who is named as an officer of it.
 *
 * This is the demo. Everything else on the globe is a position; this is the join from an asset to
 * a person, which is what the business sells. It is also the highest-harm output in the product,
 * so every rule below is a rule rather than a preference.
 *
 * **The decision is `asserted`, and nothing here compares a confidence to a threshold.** One
 * function on the server decides whether a match may be stated as fact. A card that applied its
 * own cut-off is how a card, an aggregate and the API come to disagree about the same aircraft,
 * and the disagreement would show up as a number nobody can reconcile rather than as an error.
 * The confidence exists to be *displayed* on a possible match, which is what ADR 011 asks for,
 * and for nothing else. A join at 0.99 that the server did not assert is a possible match here;
 * a join at 0.10 that it did assert is stated. Both are asserted by tests.
 *
 * **A possible match is never presented as a fact.** It is labelled, it carries its score and its
 * basis, and it says what specifically is unproven. The live example is an aircraft registering to
 * `UNITED AIRLINES INC` that resolves to United Airlines Holdings at 0.6 on a name match after
 * stripping legal suffixes: four real officers of that holding company come back, and what is
 * unproven is that the holding company is this airframe's registrant. The card has to say that,
 * because four real names attached to the wrong company is worse than no names.
 *
 * **An empty field is empty and the reason is shown.** A person with no wealth tier, no email and
 * no phone is the normal case on public sources, and eleven blanks read as a broken product unless
 * it says why. `wealth_tier_reason` is always populated by the server for exactly this.
 *
 * **A negative is dated and sourced, not an absence.** This module used to read the capability
 * list to tell "the register does not hold this airframe" from "no register is loaded", because
 * the server returned null for both and nothing in the payload separated them. It no longer does:
 * a block now arrives with its register and extract date even when there is no registrant, so the
 * card can say "the faa register, extract of 2026-08-22, does not hold this airframe" rather than
 * shrugging. `null` now means one thing only, that no register has loaded at all, and the
 * capability reading is gone with the ambiguity it existed for.
 *
 * **The register records the registered owner and that is not always the owner.** Live registrants
 * measured 2026-08-24 include `BANK OF UTAH TRUSTEE`, `UMB BANK NA TRUSTEE`, `DAE 35609 TRUST` and
 * `AC SPE 2 LLC`: five of nine were holding vehicles rather than operators. "Bank of Utah Trustee"
 * is true and reads as a bank owning an aeroplane. So the card carries a standing note about what
 * the register is, which asserts nothing about any particular row because it is true of every row.
 * It deliberately does not try to detect a trust from its name: that would be an inference from a
 * string, and the FAA's own registrant type does not distinguish a trustee from any other
 * corporation, so there would be no source behind the guess.
 */

import { hasText } from './card';
import type { AircraftOwnership, Person, Role } from '../types/entities';

/** What the card prints where the server has established no ownership. */
export const NOT_ESTABLISHED = 'not established';

/** What the card prints for a person with no wealth tier and, impossibly, no reason either. */
export const NO_TIER_REASON = 'not established, and the server gave no reason';

/** What the card prints where no asset register has loaded at all. */
export const NO_REGISTER = 'no asset register loaded';

/**
 * Why there is no ownership block, or null when there is one.
 *
 * One case now. A block arrives whenever a register has loaded, carrying its extract date even
 * when it holds nothing for the airframe, so null means the register itself is missing rather than
 * anything about this aircraft.
 */
export function absentReason(ownership: AircraftOwnership | null | undefined): string | null {
  return ownership === null || ownership === undefined ? NO_REGISTER : null;
}

/**
 * A dated, sourced negative, or null when the register does hold a registrant.
 *
 * Worth more than an absence, and the reason the server was changed to make it possible: "the faa
 * register, extract of 2026-08-22, does not hold this airframe" is a claim a reader can act on and
 * date, where a blank row is a shrug. About one airframe in five, and ordinary.
 */
export function unheldText(ownership: AircraftOwnership): string | null {
  if (hasText(ownership.registrant)) {
    return null;
  }
  return `The ${ownership.asset_register} register, extract of ${ownership.as_of}, does not hold this airframe.`;
}

/**
 * What the register is, and therefore what it cannot tell you.
 *
 * A standing qualifier rather than a judgement, in the same family as "as broadcast" on a vessel's
 * navigational status and "computed here, not observed" on a satellite's position: it is true of
 * every row, so it asserts nothing about the row in front of it. It is here because five of nine
 * live registrants were trusts, trustees or special-purpose entities, and `BANK OF UTAH TRUSTEE`
 * reads as a bank that owns an aeroplane unless the card says what kind of fact that is.
 */
export const REGISTER_CAVEAT =
  'A register records the registered owner. For a trust, a lease or a special-purpose entity that need not be the operator or the beneficial owner.';

/**
 * How the registrant should be read: a named individual, a company, or unsaid.
 *
 * Worth stating rather than leaving to the name, because "SMITH JOHN A" and "SMITH AVIATION LLC"
 * are the same shape of string and the difference decides whether a person's name is on screen.
 */
export function registrantKindText(kind: AircraftOwnership['registrant_kind']): string {
  if (kind === 'person') {
    return 'a named individual';
  }
  return kind === 'organisation' ? 'an organisation' : 'not stated by the register';
}

export type MatchState = 'asserted' | 'possible' | 'refused';

/**
 * Which of the three states a block is in, decided by `asserted` and nothing else.
 *
 * `refused` is a block with no join at all, which is the matcher declining rather than failing:
 * a registrant that matches no company in the index is the ordinary outcome for a privately held
 * aircraft, and `refused_reason` carries the matcher's own words.
 */
export function matchState(ownership: AircraftOwnership): MatchState {
  if (ownership.asserted) {
    return 'asserted';
  }
  return ownership.join === null || ownership.join === undefined ? 'refused' : 'possible';
}

/**
 * The line that says how firm the join is.
 *
 * On a possible match the score is shown, and it is shown as a score rather than as a percentage:
 * 0.6 is a matcher's output, and "60%" invites a reader to treat it as a probability of anything.
 * The word "possible" comes first because it is the qualifier that governs everything after it.
 */
export function matchText(ownership: AircraftOwnership): string {
  const state = matchState(ownership);
  if (state === 'refused') {
    // The outcome, not the reason. `refused_reason` carries both "no company in the index matched
    // this registrant", which is a fact about this aircraft, and "Set TRACKER_CONTACT_EMAIL. The
    // SEC refuses an undeclared client", which is an instruction to whoever runs the deployment.
    // Seen live on 2026-08-24: every refused block carried the second. In a value column labelled
    // "Match" that reads as the matching result, so a client watching a demo is shown a
    // configuration note where they expect a finding. The reason still reaches the card, on the
    // muted line `refusedText` feeds, where it is available without posing as an outcome.
    return NOT_ESTABLISHED;
  }
  const join = ownership.join;
  if (join === null || join === undefined) {
    // Unreachable while `asserted` implies a join, and cheap insurance if that ever stops holding:
    // a card that threw here would take the whole aircraft card down with it.
    return NOT_ESTABLISHED;
  }
  if (state === 'asserted') {
    return `Stated · ${join.basis}`;
  }
  return `Possible match, confidence ${join.confidence.toFixed(2)} · ${join.basis}`;
}

/**
 * What a possible match has not proved, in words, or null when the match is stated.
 *
 * Separate from `matchText` because it is the sentence that stops four real officer names being
 * read as this aircraft's owners. The basis says what matched; this says what did not.
 */
export function unprovenText(ownership: AircraftOwnership): string | null {
  if (matchState(ownership) !== 'possible') {
    return null;
  }
  const name = ownership.organisation?.name ?? 'this company';
  return `Not established that ${name} is the registrant of this airframe. Anyone named below is an officer of that company, not of this aircraft.`;
}

/**
 * What a refused match means for the reader, and never the server's own reason for it.
 *
 * `refused_reason` has three sources in `routes_entities.py`, and they do not share an audience.
 * One is `NOT_ON_REGISTER`, which `unheldText` already states as a dated claim. One is the
 * matcher's own words about this registrant. One is `sec.UNAVAILABLE_REASON`, which is
 * "Set TRACKER_CONTACT_EMAIL", an instruction to whoever runs the deployment.
 *
 * A capability row is read by an operator and naming a free contact address there is right. A card
 * is read by whoever is being shown the product, and printing an environment variable on the one
 * card meant to be the headline shows an audience our plumbing mid-demo. So this prints none of
 * the three.
 *
 * It says the one thing that is true whichever the cause was and that answers the reader's actual
 * question, which is why the officer list below is empty. Distinguishing the three by their text
 * would work today and stop working the first time a wording changes; the operator who needs the
 * specific cause reads it on the `ownership/officers` capability row, where it already is.
 */
export const NO_COMPANY_MATCH = 'No company match established, so no officers were looked up.';

export function refusedText(ownership: AircraftOwnership): string | null {
  // Only where a registrant was named. With no registrant there was nothing to match and
  // `unheldText` is already saying so.
  if (!hasText(ownership.registrant)) {
    return null;
  }
  return matchState(ownership) === 'refused' ? NO_COMPANY_MATCH : null;
}

/** One role, with the date it was filed, because an undated role is not evidence. */
export function roleText(role: Role): string {
  const held = [
    role.title,
    role.is_director ? 'director' : null,
    role.is_officer ? 'officer' : null,
    role.is_ten_percent_owner ? 'ten per cent owner' : null,
  ].filter((part): part is string => part !== null && part !== undefined && part !== '');
  const titles = held.length === 0 ? 'role not stated' : held.join(', ');
  return `${titles}, ${role.organisation_name}, as of ${role.as_of}`;
}

/**
 * A person's wealth tier, or the server's reason for there being none.
 *
 * Never omitted. A profile with no tier is the normal case, because no keyless public source
 * publishes one, and a missing row reads as a product that failed rather than one that declined.
 */
export function wealthTierText(person: Person, reason: string): string {
  if (person.wealth_tier !== null && person.wealth_tier !== undefined) {
    return person.wealth_tier;
  }
  return reason === '' ? NO_TIER_REASON : reason;
}

/**
 * Why the officer list is empty, or null when it is not empty or the emptiness is expected.
 *
 * Three different emptinesses. No join means nobody was looked up, and the match line already
 * says that, so this stays quiet. A join with `degraded_reason` means the lookup was attempted
 * and failed, which is worth saying. A join with neither means the company filed nothing, which
 * is a real answer about a real company and is also worth saying, because a blank list otherwise
 * reads as a fault.
 */
export function officersAbsentText(ownership: AircraftOwnership): string | null {
  if (ownership.officers.length > 0) {
    return null;
  }
  if (ownership.degraded_reason !== null && ownership.degraded_reason !== undefined) {
    return ownership.degraded_reason;
  }
  return matchState(ownership) === 'refused' ? null : 'no officer filings found for this company';
}

/**
 * Contact attributes, which are PII and are almost always empty.
 *
 * Empty is the normal case rather than missing data: public sources fill few of these, and the
 * business sells packages defined by their exclusion. So this reports the count rather than
 * printing values, which keeps a card from becoming a contact sheet by accident and keeps the
 * suppression story true: there is nothing here to suppress because there is nothing here.
 */
export function contactText(person: Person): string {
  const held = person.emails.length + person.phones.length;
  return held === 0 ? 'none held' : `${String(held)} held, marked PII`;
}

/** The rows for one officer, in the order a reader needs them. */
export function officerRows(person: Person, tierReason: string): readonly [string, string][] {
  const rows: [string, string][] = [['Name', person.name]];
  for (const role of person.roles) {
    rows.push(['Role', roleText(role)]);
  }
  rows.push(['Wealth tier', wealthTierText(person, tierReason)], ['Contact', contactText(person)]);
  return rows;
}

/**
 * The rows for the ownership block itself, above any officer.
 *
 * `as_of` is the register's own extract date and is labelled as such. It is never the date of the
 * request, which is the mistake that would make a month-old extract look like today's answer.
 */
export function ownershipRows(ownership: AircraftOwnership): readonly [string, string][] {
  const registrant = ownership.registrant;
  const named = hasText(registrant);
  // The register and its extract date go on every block, held or not: they are what makes a
  // negative dated and sourced rather than blank.
  const rows: [string, string][] = [
    ['Register', `${ownership.asset_register}, extract of ${ownership.as_of}`],
  ];
  if (named) {
    rows.push(
      ['Registrant', registrant],
      ['Registrant is', registrantKindText(ownership.registrant_kind)],
      ['Match', matchText(ownership)],
    );
  }
  const organisation = ownership.organisation;
  if (organisation !== null && organisation !== undefined) {
    rows.push(['Filing entity', organisation.name]);
    if (organisation.sec_cik !== null && organisation.sec_cik !== undefined) {
      rows.push(['SEC CIK', organisation.sec_cik]);
    }
    if (organisation.ticker !== null && organisation.ticker !== undefined) {
      rows.push(['Ticker', organisation.ticker]);
    }
  }
  const basis = ownership.officers_basis;
  if (basis !== null && basis !== undefined && ownership.officers.length > 0) {
    rows.push(['Officers from', basis]);
  }
  return rows;
}
