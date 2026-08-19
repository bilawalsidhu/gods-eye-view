# ADR 008: profiles carry contact and identity attributes, and erasure is a feature

**Date:** 2026-08-19
**Status:** Accepted
**Amends:** ADR 006 (location as a profile attribute), which described address narrowly, and
ADR 002. **Closes** the jurisdiction question left open in ADR 004 and restated in ADR 007.
**Reads with** ADR 007, which permits a person to be joined to any data in the system.

## Context

ADR 007 removed the firewall around person records and made the join the product. It did not
say what a profile actually holds. ADR 006 allowed an address only where it was "the
profile's own business or registered address", which is narrower than the real data model
and narrower than the thing being demoed.

Altrata's production profile is wider than that, and by a long way. The Person Identity
Pipeline refreshes address, phone and email master tables against the profile's name,
alternate names, date of birth and gender. Contact data is bought as well as scraped: the
NeuStar contact pipeline supplies address, email and phone at a scale of tens of millions of
rows, marked PII in the data dictionary. Personal address is a separate table in the data
feed and the platform shows up to fifty personal addresses per profile. Contact data is
commercially material enough that the business sells packages defined by its absence:
`Core-NoContactData` strips email addresses and phone numbers, `Core-NoPII` strips
nationality, gender, date of birth, age, deceased date, diversity, residence, hometown,
personal email and personal phone. A field only gets an exclusion package because customers
are buying it by default.

A demo of profile enrichment whose profile has no contact attributes is demoing a thinner
product than the one that exists. It also weakens the join, because contact attributes are
match keys: address and email are how a scraped record and a bought record get resolved to
one person in the first place.

The jurisdiction framing has now been wrong twice in this repo. ADR 004 made UK GDPR Article
6(1)(f), a DPIA and an Article 14(5)(b) notice the gate. ADR 006 corrected that to US state
law but left ADR 004's wording in place, and ADR 007 then reintroduced "the UK GDPR position
is now load-bearing and unresolved". It is not the instrument. Altrata does not operate in
GDPR jurisdiction for this population: the profiles and the customers are in the United
States, which has no single federal privacy law and instead a patchwork, with California's
CCPA and CPRA the sharpest edge, the California Delete Act reaching data brokers directly,
and Virginia, Colorado, Connecticut, Utah and others behind them. The CCPA right to delete
is narrower than GDPR erasure: it covers personal information collected from the consumer,
which does not automatically reach data obtained from a public profile or a third party.

None of which is the reason we honour a removal request. The business already honours it as
a standing policy regardless of which law applies, and it is the same mechanism the product
already demos for FAA LADD and privacy ICAO addresses.

## Decision

**A profile carries contact and identity attributes.** Modelled on the production person
record, each entry dated and carrying its source:

- Personal and business email addresses.
- Personal and business phone numbers.
- Postal addresses, home address included, as a dated series rather than one current value.
- Identity attributes used for resolution: name and alternate names, date of birth, age,
  gender, nationality, deceased date, hometown or place of birth.
- Social handles, including LinkedIn.

Every one of them follows the rules already in force and gains nothing new: a date and a
source on every entry, an undated entry dropped at the adapter and counted, an entry
produced by joining sources labelled derived rather than reported, and provenance on the
card. See ADR 006.

**The join to everything else is the point of holding them.** Contact attributes are match
keys as much as they are display fields, and the entity resolution in phase 6 uses them.
This is the same statement ADR 007 made about live feeds, applied to identity: a profile
that cannot be resolved against the rest of the data is not a profile of any commercial
value, and this project exists to demonstrate the resolution.

**What the demo actually populates is limited by its sourcing, not by its schema.** The
project is public sources only, so it holds no bought vendor contact file and most profiles
will carry no personal phone number and no home address. The contract supports the
attribute; the demo shows what public sources give. Where a field is empty it is empty, and
no default, approximation or inference fills it.

**Contact attributes are marked PII in the contract**, so that the exclusion behaviour the
business sells can be demonstrated rather than described. The card and the API can serve a
profile with contact data suppressed, mirroring the `NoContactData` and `NoPII` packages.

**Right to be forgotten is a product feature, honoured whatever the jurisdiction.** A
removal request removes the record, suppresses it, or both:

- **Removal** deletes the record and its identifiers.
- **Suppression** keeps a key that survives re-ingest so the next crawl does not resurrect
  the record, and the suppression key holds no more personal data than the flag needs.
- The suppression is visible in the product with its reason, the same as an FAA LADD
  opt-out.
- The target is completion inside thirty days, matching the business standard. In this
  project there is no request queue and no human step, so the control is exposed directly
  and takes effect immediately.

## What this does not change

- **No face recognition or person identification on any camera image.**
- **No aggregators of unsecured private cameras.**
- **No de-anonymising of a privacy ICAO address, and LADD suppression is honoured.** These
  are opt-outs the individual has already exercised, which is exactly what this ADR is
  building on the person side.
- **No wealth tier, net worth figure or wealth signal inferred from a feed, a position or a
  track.** A tier comes from a profile or it does not exist. Unchanged since ADR 002.
- **Sourcing obligations under ADR 004.** Every source recorded in `docs/data-sources.md`
  with its collection method and licence position, robots and rate limits honoured in code,
  scraped origin shown as scraped, permissive at the wire layer and strict at the domain
  layer.

## Consequences

**This is personal data of the most sensitive practical kind on a security-sensitive
population.** A home address and a phone number on a named UHNW individual, joined to live
asset positions under ADR 007, is the highest-harm combination the project can hold. Saying
it plainly is the point of this paragraph. What stands between the demo and harm is now
entirely operational: the confidence threshold, the provenance display, the derived label,
the PII suppression and the removal control. There is no structural test left doing it.

**A wrong contact attribute is worse than a wrong location.** A misjoined phone number or
address attaches a real stranger to a named profile, which is both a false statement and a
route to contacting the wrong person. The confidence threshold and the "possible match"
display are load-bearing here and are not tuned down for a better-looking demo.

**The US privacy position is still a phase 6 deliverable and is now specifically about
contact data**: which state laws reach the population, how access and deletion requests are
served inside the statutory windows, whether data broker registration applies, and the CCPA
nuance that the right to delete reaches data collected from the consumer rather than
everything held. It replaces the UK GDPR paperwork in ADR 004 and ADR 007 outright. It is a
blocker on any public deployment carrying real profiles.

**The contract grows a PII marker and the API grows a suppressed view.** Both are demo
features rather than plumbing, because "we can sell you this profile without the contact
data" is a real product line.

## Alternatives considered

**Hold identity attributes but not contact attributes.** Rejected. Email and address are
the two strongest match keys in the business, so dropping them would make the resolution
demo weaker than the thing it demonstrates.

**Hold contact attributes but never display them.** Rejected as dishonest. If the profile
holds a home address, the demo should show that it holds it, with its source and its date,
and show the suppression control working. Hiding it in the schema is the failure mode ADR
002 warned about, in reverse.

**Keep the UK GDPR framing as the conservative option.** Rejected. It is the wrong law for
a US population, it has been wrong in this repo twice, and writing a compliance gate against
a regime that does not apply produces paperwork nobody can act on while leaving the state
laws that do apply undocumented.
