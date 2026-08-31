/**
 * The ownership spine's rules, which are rules rather than formatting preferences.
 *
 * Four of these tests exist because getting them wrong would put a real person's name against an
 * aircraft they have nothing to do with, which is the highest-harm output this product has. They
 * are written as the rule they protect rather than as the string they produce, so a later change
 * to the wording does not quietly take the rule with it.
 */

import { describe, expect, it } from 'vitest';

import {
  NOT_ESTABLISHED,
  NO_COMPANY_MATCH,
  NO_REGISTER,
  NO_TIER_REASON,
  REGISTER_CAVEAT,
  absentReason,
  contactText,
  matchState,
  matchText,
  officerRows,
  officersAbsentText,
  ownershipRows,
  refusedText,
  registrantKindText,
  roleText,
  unprovenText,
  unheldText,
  wealthTierText,
} from './ownership';
import type { AircraftOwnership, Join, Person, Role } from '../types/entities';

function makeJoin(overrides: Partial<Join> = {}): Join {
  return {
    as_of: '2026-08-10',
    basis: 'exact normalised name match against the SEC company index',
    confidence: 0.95,
    inferred: false,
    origin_key: 'sec:0000092380',
    source: 'sec',
    target_id: '0000092380',
    target_kind: 'organisation',
    ...overrides,
  };
}

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    as_of: '2026-08-10',
    is_director: true,
    is_officer: false,
    is_ten_percent_owner: false,
    organisation_id: '0000092380',
    organisation_name: 'Southwest Airlines Co',
    origin_key: 'sec:form4:1',
    source: 'sec',
    ...overrides,
  };
}

function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    kind: 'person',
    person_id: 'sec:1234567',
    name: 'DOE JANE',
    addresses: [],
    claims: [],
    emails: [],
    phones: [],
    joins: [],
    roles: [makeRole()],
    ...overrides,
  };
}

function makeOwnership(overrides: Partial<AircraftOwnership> = {}): AircraftOwnership {
  return {
    registrant: 'SOUTHWEST AIRLINES CO',
    registrant_kind: 'organisation',
    asset_register: 'faa',
    as_of: '2026-08-20',
    asserted: true,
    join: makeJoin(),
    organisation: {
      kind: 'organisation',
      organisation_id: '0000092380',
      name: 'Southwest Airlines Co',
      registry_names: ['SOUTHWEST AIRLINES CO'],
      joins: [],
      sec_cik: '0000092380',
    },
    officers: [makePerson()],
    officers_basis: 'named on an SEC Form 3, 4 or 5 filed against this issuer',
    wealth_tier_reason: 'Wealth tier not established: no keyless public source publishes one.',
    ...overrides,
  };
}

/**
 * The rule that matters most: the server decides, and this card reports.
 *
 * Written as two opposed cases rather than as one, because the failure it guards against is a
 * threshold appearing in the card, and a threshold is only visible when the confidence and the
 * decision disagree.
 */
describe('the decision is `asserted`, never a threshold on confidence', () => {
  it('treats a high-confidence join the server did not assert as a possible match', () => {
    // 0.99 is above any cut-off anyone would pick. It is still not a fact, because the server did
    // not say so, and a card that applied its own threshold here would state it.
    const high = makeOwnership({ asserted: false, join: makeJoin({ confidence: 0.99 }) });

    expect(matchState(high)).toBe('possible');
    expect(matchText(high)).toContain('Possible match');
  });

  it('states a low-confidence join the server did assert', () => {
    // 0.10 is below any cut-off anyone would pick. The server asserted it, so it is stated, and a
    // card second-guessing that is how a card and an aggregate come to disagree.
    const low = makeOwnership({ asserted: true, join: makeJoin({ confidence: 0.1 }) });

    expect(matchState(low)).toBe('asserted');
    expect(matchText(low)).toContain('Stated');
    expect(matchText(low)).not.toContain('Possible');
  });

  it('never prints a confidence on a stated match', () => {
    // A score next to a fact invites the reader to discount the fact.
    expect(matchText(makeOwnership({ asserted: true }))).not.toContain('0.9');
  });

  it('prints the confidence as a score rather than as a percentage', () => {
    // "60%" reads as a probability of something. 0.60 reads as a matcher's output, which is what
    // it is.
    const possible = makeOwnership({ asserted: false, join: makeJoin({ confidence: 0.6 }) });

    expect(matchText(possible)).toContain('confidence 0.60');
    expect(matchText(possible)).not.toContain('%');
  });
});

describe('a refused match states the outcome, not the deployment', () => {
  const refused = makeOwnership({
    asserted: false,
    join: null,
    organisation: null,
    officers: [],
    refused_reason: 'Set TRACKER_CONTACT_EMAIL. The SEC refuses an undeclared client.',
  });

  it('keeps a configuration instruction out of the Match value', () => {
    // Seen live on 2026-08-24: every refused block carried this string, and in a column labelled
    // "Match" it reads as the matching result. A client watching a demo should not be shown an
    // environment variable where they expect a finding.
    expect(matchText(refused)).toBe(NOT_ESTABLISHED);
    expect(matchText(refused)).not.toContain('TRACKER_CONTACT_EMAIL');
  });

  it('never puts an environment variable on a card, whatever the server sent', () => {
    // The rule, and it is about audience rather than about wording. A capability row is read by an
    // operator; a card is read by whoever is being shown the product. Asserted against all three
    // sources of `refused_reason` at once, so a fourth one cannot leak through either.
    for (const reason of [
      'Set TRACKER_CONTACT_EMAIL. The SEC refuses an undeclared client.',
      'no company in the index matched this registrant',
      'this register does not hold that airframe',
    ]) {
      const text = refusedText(
        makeOwnership({ asserted: false, join: null, refused_reason: reason }),
      );

      expect(text).not.toContain('TRACKER_CONTACT_EMAIL');
      expect(text).not.toContain('Set ');
    }
  });

  it('answers the reader question instead, which is why the officer list is empty', () => {
    expect(refusedText(refused)).toBe(NO_COMPANY_MATCH);
    expect(refusedText(refused)).toContain('no officers were looked up');
  });

  it('says nothing when there was no registrant to match', () => {
    // `unheldText` is already stating the dated negative, so a second line would repeat it.
    const unheld = makeOwnership({ registrant: null, asserted: false, join: null });

    expect(refusedText(unheld)).toBeNull();
  });

  it('says nothing at all when a match was made', () => {
    expect(refusedText(makeOwnership())).toBeNull();
  });
});

describe('a possible match is never presented as a fact', () => {
  it('says what specifically is unproven, naming the company', () => {
    // The live case: an aircraft registered to UNITED AIRLINES INC resolving to the holding
    // company at 0.6, with four real officers of that holding company attached. Four real names
    // against the wrong company is worse than no names, so the card has to say which is which.
    const possible = makeOwnership({
      asserted: false,
      registrant: 'UNITED AIRLINES INC',
      join: makeJoin({
        confidence: 0.6,
        basis: 'name match after stripping legal suffixes, parent company not confirmed',
      }),
      organisation: {
        kind: 'organisation',
        organisation_id: '0000100517',
        name: 'United Airlines Holdings, Inc.',
        registry_names: ['UNITED AIRLINES INC'],
        joins: [],
        sec_cik: '0000100517',
      },
    });

    const unproven = unprovenText(possible);

    expect(unproven).toContain('United Airlines Holdings');
    expect(unproven).toContain('Not established');
    expect(unproven).toContain('officer of that company, not of this aircraft');
  });

  it('says nothing extra on a stated match, because there is nothing unproven to say', () => {
    expect(unprovenText(makeOwnership({ asserted: true }))).toBeNull();
  });

  it('still warns when the match has no organisation to name', () => {
    const nameless = makeOwnership({ asserted: false, organisation: null });

    expect(unprovenText(nameless)).toContain('Not established');
  });
});

/**
 * The absences, now that the server tells them apart itself.
 *
 * This used to read the capability list, because `ownership: null` meant both "the register does
 * not hold this airframe" and "no register is loaded" and nothing separated them. The server now
 * sends a block carrying its register and extract date even when it holds nothing, so a negative
 * is dated and sourced and null means one thing. The capability reading went with the ambiguity.
 */
describe('absent ownership', () => {
  it('says only that no register loaded when the block is missing entirely', () => {
    expect(absentReason(null)).toBe(NO_REGISTER);
    expect(absentReason(undefined)).toBe(NO_REGISTER);
  });

  it('says nothing at all when there is a block', () => {
    expect(absentReason(makeOwnership())).toBeNull();
  });

  it('dates and sources a negative rather than leaving it blank', () => {
    // The live shape, measured 2026-08-24: one of ten held aircraft came back with no registrant,
    // a register of `faa`, an extract of 2026-08-22 and "this register does not hold that
    // airframe". A reader can date and act on that; a blank row is a shrug.
    const unheld = makeOwnership({
      registrant: null,
      registrant_kind: null,
      as_of: '2026-08-22',
      asserted: false,
      join: null,
      organisation: null,
      officers: [],
      refused_reason: 'this register does not hold that airframe',
    });

    expect(unheldText(unheld)).toBe(
      'The faa register, extract of 2026-08-22, does not hold this airframe.',
    );
  });

  it('says nothing of the kind when the register did name somebody', () => {
    expect(unheldText(makeOwnership())).toBeNull();
  });

  it('leaves the registrant rows out when there is no registrant', () => {
    // A row reading "Registrant: undefined" is worse than no row, and the register row stays
    // either way because it is what dates the negative.
    const names = ownershipRows(makeOwnership({ registrant: null, registrant_kind: null })).map(
      ([name]) => name,
    );

    expect(names).toContain('Register');
    expect(names).not.toContain('Registrant');
    expect(names).not.toContain('Match');
  });
});

/**
 * What the register is, said once and always.
 *
 * Five of nine live registrants on 2026-08-24 were holding vehicles rather than operators: `BANK
 * OF UTAH TRUSTEE`, `UMB BANK NA TRUSTEE`, `DAE 35609 TRUST`, `AC SPE 2 LLC`. "Bank of Utah
 * Trustee" is exactly what the register says and reads as a bank that owns an aeroplane.
 */
describe('the register caveat', () => {
  it('says what a register records, without judging the row in front of it', () => {
    expect(REGISTER_CAVEAT).toContain('registered owner');
    expect(REGISTER_CAVEAT).toContain('need not be the operator or the beneficial owner');
  });

  it('names no particular structure, so it asserts nothing about any one aircraft', () => {
    // Deliberately not a detector. Deciding "this is a trust" from the string would be an
    // inference with no source behind it, and the FAA's own registrant type does not distinguish
    // a trustee from any other corporation.
    expect(REGISTER_CAVEAT).not.toContain('BANK');
    expect(REGISTER_CAVEAT).not.toContain('this aircraft');
  });
});

describe('the wealth tier is shown empty with its reason, never omitted', () => {
  it('prints the tier when there is one', () => {
    expect(wealthTierText(makePerson({ wealth_tier: 'UHNW' }), 'irrelevant')).toBe('UHNW');
  });

  it('prints the reason when there is none, because a blank reads as a fault', () => {
    // Eleven empty fields on a person read as a broken product unless it says why, and no keyless
    // public source publishes a tier, so this is the normal case rather than the edge.
    const reason = 'Wealth tier not established: no keyless public source publishes one.';

    expect(wealthTierText(makePerson(), reason)).toBe(reason);
  });

  it('says something even if the server sent no reason, which it should not', () => {
    expect(wealthTierText(makePerson(), '')).toBe(NO_TIER_REASON);
  });
});

describe('officers', () => {
  it('names the filing that put a person on the card', () => {
    const rows = ownershipRows(makeOwnership());

    expect(rows).toContainEqual([
      'Officers from',
      'named on an SEC Form 3, 4 or 5 filed against this issuer',
    ]);
  });

  it('does not claim a basis when no officer came back', () => {
    const rows = ownershipRows(makeOwnership({ officers: [] }));

    expect(rows.map(([name]) => name)).not.toContain('Officers from');
  });

  it('says the lookup failed when there is a join and a degraded reason', () => {
    const degraded = makeOwnership({ officers: [], degraded_reason: 'SEC returned 403' });

    expect(officersAbsentText(degraded)).toBe('SEC returned 403');
  });

  it('says the company filed nothing when the join held and no filing did', () => {
    // A real answer about a real company, and worth saying: a blank list otherwise reads as a
    // fault in the product rather than as an absence of filings.
    expect(officersAbsentText(makeOwnership({ officers: [] }))).toBe(
      'no officer filings found for this company',
    );
  });

  it('stays quiet when nothing was ever looked up', () => {
    // The match line already says the registrant matched no company, so a second sentence saying
    // no officers were found would be repeating it.
    const refused = makeOwnership({
      asserted: false,
      join: null,
      organisation: null,
      officers: [],
      refused_reason: 'no company in the index matched this registrant',
    });

    expect(officersAbsentText(refused)).toBeNull();
  });

  it('reports contact attributes as a count and never as values', () => {
    // Empty is the normal case: public sources fill few of these and the business sells packages
    // defined by their exclusion. Counting rather than printing keeps a card from becoming a
    // contact sheet by accident.
    expect(contactText(makePerson())).toBe('none held');
    expect(contactText(makePerson({ emails: ['a@b.c'], phones: ['+1'] }))).toBe(
      '2 held, marked PII',
    );
  });
});

describe('officerRows', () => {
  it('leads with the name, then every dated role, then the tier and the contact count', () => {
    // The order is the point: a reader meets who this is, then the evidence that put them on the
    // card, then the two fields that are almost always empty.
    const rows = officerRows(makePerson(), 'no keyless public source publishes one');

    expect(rows.map(([name]) => name)).toEqual(['Name', 'Role', 'Wealth tier', 'Contact']);
    expect(rows[0]).toEqual(['Name', 'DOE JANE']);
  });

  it('gives a person with several filings a row for each', () => {
    const many = makePerson({
      roles: [makeRole({ title: 'Director' }), makeRole({ title: 'Chief Financial Officer' })],
    });

    expect(officerRows(many, 'x').filter(([name]) => name === 'Role')).toHaveLength(2);
  });

  it('still shows the tier and the contact count for a person with no filings at all', () => {
    // A person reached through a join but with no role filed is not a broken record, and the two
    // rows that say so must not vanish with the roles.
    const rows = officerRows(makePerson({ roles: [] }), 'not established');

    expect(rows.map(([name]) => name)).toEqual(['Name', 'Wealth tier', 'Contact']);
    expect(rows).toContainEqual(['Contact', 'none held']);
  });
});

describe('roleText', () => {
  it('dates every role, because an undated role is not evidence', () => {
    expect(roleText(makeRole({ title: 'Chief Financial Officer' }))).toBe(
      'Chief Financial Officer, director, Southwest Airlines Co, as of 2026-08-10',
    );
  });

  it('lists every flag the filing set', () => {
    const all = makeRole({ title: null, is_officer: true, is_ten_percent_owner: true });

    expect(roleText(all)).toContain('director, officer, ten per cent owner');
  });

  it('says the role is unstated rather than printing an empty title', () => {
    const bare = makeRole({ title: null, is_director: false, is_officer: false });

    expect(roleText(bare)).toContain('role not stated');
  });
});

describe('the registrant', () => {
  it('says whether the register named a person or a company', () => {
    // "SMITH JOHN A" and "SMITH AVIATION LLC" are the same shape of string, and the difference
    // decides whether an individual's name is on screen.
    expect(registrantKindText('person')).toBe('a named individual');
    expect(registrantKindText('organisation')).toBe('an organisation');
    expect(registrantKindText('unknown')).toBe('not stated by the register');
  });

  it('dates the register extract rather than the request', () => {
    // A month-old extract must not read as today's answer.
    expect(ownershipRows(makeOwnership())).toContainEqual([
      'Register',
      'faa, extract of 2026-08-20',
    ]);
  });

  it('carries the ticker when the filing entity has one', () => {
    // A public company's ticker is the fastest way for a reader to check the match themselves,
    // and it is optional in the contract, so both directions matter.
    const listed = makeOwnership({
      organisation: {
        kind: 'organisation',
        organisation_id: '0000092380',
        name: 'Southwest Airlines Co',
        registry_names: [],
        joins: [],
        sec_cik: '0000092380',
        ticker: 'LUV',
      },
    });

    expect(ownershipRows(listed)).toContainEqual(['Ticker', 'LUV']);
    expect(ownershipRows(makeOwnership()).map(([name]) => name)).not.toContain('Ticker');
  });

  it('carries the registrant exactly as the register wrote it', () => {
    // Not normalised, not title-cased. What the register says is the evidence.
    expect(ownershipRows(makeOwnership())).toContainEqual(['Registrant', 'SOUTHWEST AIRLINES CO']);
  });
});
