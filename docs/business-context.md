# Business context

Why this project exists, who pays for the thing it demonstrates, and where it stops.
Read this before `docs/architecture.md`. Sources for every claim below are Confluence
pages, listed at the end.

## What the business sells

Altrata sells wealth and executive intelligence. The shape of the business is:

1. Collect data on people and organisations at scale: scrape the public web, extract from
   filings, and buy in licensed datasets.
2. Resolve it to one person or one organisation, and keep it current.
3. Join it up: roles, boards, education, philanthropy, family, assets, relationships.
4. Sell the resulting insight to clients as a platform, an API and data feeds.

Clients are private banks and wealth managers, university advancement teams, nonprofit
fundraisers, luxury brands and premium B2B sales teams. What they buy is the answer to
"who is worth talking to, what are they worth, and who do we already know who can
introduce us".

The distinctive asset is the join, not any single field. Net worth on its own is a number.
Net worth plus a board seat plus a shared alma mater plus a foundation trusteeship is a
warm introduction, and that is the product.

## The wealth tiers

This vocabulary is fixed and shared across the business. Use these exact terms in code,
contracts and docs. Do not invent synonyms.

| Tier | Threshold |
| --- | --- |
| HNW, high net worth | Net worth over $1m, excluding primary residence |
| VHNW, very high net worth | Net worth between $5m and $30m |
| UHNW, ultra high net worth | Net worth over $30m |

HNW is an industry term rather than a working segment. Wealth-X does not use it, because
almost every target prospect is at least VHNW and HNW prospects are of less interest to
clients.

Two further tiers are ours rather than the industry's, and both mean "a partial valuation
puts them here if it were finished":

- **Likely VHNW**: total assets or net worth of $2m to $5m on an incomplete valuation.
- **Likely UHNW**: a single asset of $5m or more, or total assets of $20m to $29.9m, on an
  incomplete valuation.

A profile carries exactly one tier. Where two would apply, the higher one wins: a profile
that is both Confirmed VHNW and Likely UHNW displays as Likely UHNW.

In the platform this field is the wealth tier, derived from the Wealth-X dossier category.

## Where the data comes from

Scraping the public web is core collection, not an edge case. It runs alongside licensed
datasets (TransUnion for wealth, LexisNexis, Dun & Bradstreet), public filings and
registries, and in-house research. Three named pipelines do the collecting, and all three
share one shape: a machine fetches, a language model extracts, a researcher verifies, and
the record lands in the dataset with its source attached.

**Leadership Extractor (LE)** scrapes company websites for leadership. It finds the
leadership page on an organisation's site, detects when that page has changed, extracts the
change with an LLM, and feeds it downstream to be reviewed or auto-ingested. The scale is
the whole private organisation universe, the line in the sand being 1,507,582 organisations
as of 15 July 2024, each scanned once a week, at a target cost of roughly $2.84 per
thousand organisations against a budget of about $223,000 a year. We fetch ourselves first,
use a SERP API when the sitemap does not give up the leadership page, and fall back to
ScraperAPI when we are blocked. The KPIs are under 10% overall scrape failure, under 5%
failing to find the leadership page, under 5% failing to extract from it. Scraping vendors
get benchmarked on block rate and cost (ScraperAPI, ScrapingBee, ScrapingAnt, Scraping Fish
and Jina among them) and extraction runs on Azure AI Foundry models, moving off the GPT-4.x
and o4-mini set onto GPT-5.

**Annual Report Extractor (ARX)** extracts from documents rather than pages. Researchers
load a company's annual report, financial statement, corporate governance report,
sustainability report, DEF 14A, 10-K, 20-F, 40-F or AIF, and an LLM-assisted workflow pulls
out board composition, senior leadership, committees, advisors, future announcements,
remuneration and demographics such as revenue, employee count, address and website. The
researcher validates each extraction against the source view and the page number, uses
ChatGPT prompts to cross-check the company website for recent changes, and falls back to
manual research where extraction fails. Any board, senior management or leadership entry
needs a validation source dated within the last 18 months or it goes to mandatory manual
review. ARX is a FastAPI service on Fargate with a React SPA, internal only, behind a
private load balancer and corporate SSO.

**AI Profile Builder (AIPB)** builds a profile from the web on minimal input, a name, a
role, an organisation, a location, and returns it in the platform and by email. The point is
commercial: serve client requests for people outside the researched universe quickly and at
a lower price point than a manual build, grow credit spend, and pull those profiles into the
in-scope universe. AI-generated profiles carry an explicit disclaimer, and the open
questions on the record are whether clients accept them and whether they cannibalise the
manual profile business.

In the business, a researcher sits on the end of all three and verifies before a record
lands. That is the step this project does not have.

**Buying is the other half of collection.** Alongside the scraping sit bought files:
TransUnion for wealth, LexisNexis, Dun & Bradstreet, and a contact file from NeuStar
supplying postal address, email and phone at a scale of tens of millions of rows, marked PII
in the vendor's own data dictionary. The Person Identity Pipeline then refreshes the address,
phone and email master tables against the profile's name, alternate names, date of birth and
gender, which is how a bought row and a scraped row become one person. This project buys
nothing, holds no vendor file, and leaves the fields a bought file would fill empty.

## What a profile holds

The production person record is wide, and this project models the same shape. See ADR 008.

Identity: name and alternate names, date of birth, age, gender, nationality, deceased date,
hometown or place of birth. Contact: personal and business email, personal and business
phone, postal addresses including home addresses, social handles including LinkedIn. On top
of that sit the wealth tier, roles, boards, philanthropy, relationships and dated locations.

The contact fields are not an edge case, they are a product line. Personal address is its own
table in the data feed and the platform shows up to fifty personal addresses on a profile.
Contact data is commercially material enough that the business sells packages defined by its
absence: `Core-NoContactData` strips email addresses and phone numbers, `Core-NoPII` strips
nationality, gender, date of birth, age, deceased date, diversity, residence, hometown,
personal email and personal phone. A field only earns an exclusion package because customers
are buying it by default.

Two reasons the attributes matter to this demo. First, a profile enrichment demo whose
profile is thinner than the real one is demoing the wrong product. Second, contact attributes
are the match keys: address and email are how a scraped record and a bought record resolve to
one person, so they carry the join as much as they carry the display.

Public sources fill few of them, and that is fine. An empty field stays empty here, with no
default, approximation or inference filling the gap.

## No human verification here, ever

This is a proof of concept and a demo. There is no researcher, no review queue, no QA step,
and none is coming. Nothing may be designed on the assumption that a person will check it.

That is a rule, not a stage of maturity:

- No workflow that pauses for approval, no pending-review state, no admin screen for
  accepting or rejecting a record.
- Nothing renders that a human was supposed to have signed off. If the machine cannot
  stand behind it, it does not appear.
- The machine carries the whole burden instead. Strict contracts at the domain boundary,
  unmappable records dropped and counted, a confidence threshold below which no link is
  asserted, and provenance shown on every card so the viewer can judge it themselves.
- A low-confidence match is displayed as unconfirmed with its score and excluded from every
  aggregate. It is never quietly promoted and never queued for someone to bless.

The reason this matters: the business relies on that human step to catch duplicate profiles
and chimera profiles (attributes of several people wrongly merged), both live production
problems. Without the researcher, the only defence left is being conservative in code, so
the thresholds and the drop-and-count behaviour are load-bearing rather than tidy.

The rest of the sourcing posture applies as written, under ADR 004 in `docs/decisions/`.
Scraped and crowd-sourced sources are permitted anywhere, the people layer included. The
obligations are in `AGENTS.md` under Data sourcing: record the collection method and licence
position in `docs/data-sources.md`, validate scraped input hardest, show a scraped origin as
scraped on the card, and honour `robots.txt` and rate limits in code. The bar that does not
move is that a feed we cannot name, date and account for licence-wise does not belong here.

## What this project is

A demo of profile enrichment, built on **public sources only**, shaped to Altrata's real
data model, so it can be shown without touching licensed data or production systems.

The commercial story it tells: take a wealth profile, join it to the assets that profile
owns, and put those assets on a globe live. Altrata already licenses private aircraft
ownership (JetNet), luxury vehicle ownership and US real estate (CoreLogic). This project
rebuilds that join from public registries and live public feeds, so the value of the join
is visible without the licensing conversation.

The aggregate signal is the part worth selling: frequented airfields and marinas, wealth
hub corridors, and traffic into a hub during a known event. That is phase 8. It is
computed across a portfolio of assets and never resolves to one person's whereabouts.

## Where it stops

The wealth focus does not change the people layer, and this is the line that matters most.

UHNW individuals are exactly the population for whom a locator would be dangerous, and
being a target is a real security concern for them and their families. So:

- **A person may be joined to any data in the system**, live position feeds included. ADR
  007 removed the structural firewall that used to sit here, and the separation test with
  it. Read ADR 002 for the argument that was overruled and ADR 007 for what replaced it,
  in full, before going near the people layer.
- What limits exposure now is evidence rather than architecture: a source, a confidence and
  an as-of date on every join, sub-threshold joins shown as possible matches and counted
  nowhere, inferences labelled as inferences, and a removal request that removes and
  suppresses the record. None of those is optional and none is tuned for a better demo.
- The security exposure is real and is now unmitigated by design: this population is exactly
  the one for whom being locatable is dangerous. That was the argument against, it was
  considered, and it was overruled. It is written down here so nobody has to guess whether
  it was thought about.
- A wrong contact attribute is worse than a wrong location. It attaches a real stranger to a
  named profile and hands someone a way to contact them, so the confidence threshold and the
  "possible match" display carry more weight here than anywhere else in the product.
- No net worth figure, wealth tier or wealth signal is ever inferred from a live feed.
  Owning a Gulfstream is not an estimated net worth, and the code never treats it as one.
- Wealth tiers in this project come from a profile, never from a position, a track or an
  event.

## Erasure, and which law actually applies

Altrata honours a right to be forgotten as a standing policy. An individual may ask to be
removed, suppressed, or both: removal deletes the record and its identifiers, suppression
keeps a flag that stops the record being re-ingested or displayed, and the suppression key
holds no more personal data than the flag needs. The business targets completion inside
thirty days. In this project there is no request queue and no human step, so the control is
exposed directly and takes effect immediately, and the suppression shows in the product with
its reason. It is the same mechanism already demoed for FAA LADD opt-outs and privacy ICAO
addresses.

We do that as policy, not because a regulator compels it. **This is not GDPR territory.** The
profiles and the customers are in the United States, which has no single federal privacy law
and instead a patchwork: California's CCPA and CPRA are the sharpest edge, the California
Delete Act reaches data brokers directly, and Virginia, Colorado, Connecticut and Utah sit
behind them. The CCPA right to delete is narrower than GDPR erasure, covering personal
information collected from the consumer rather than everything held, which does not
automatically reach data taken from a public profile or bought from a third party. Earlier
drafts of this repo made UK GDPR the gate. That was wrong twice, and ADR 008 settled it.

Writing the US position is a phase 6 deliverable and a hard gate on any public deployment
carrying real profiles: which state laws reach the population, how access and deletion
requests are served inside the statutory windows, and whether data broker registration
applies.

Several sources here are free for non-commercial use only. As it stands this is a demo and
is not licensed for commercial deployment.

## Confluence sources

- Altrata Solutions, "4 - Data": the data domains, universe and curation model.
- Data Product Management, "Net Worth Classifications/Thresholds": the tier definitions.
- Platform Integration, "Wealthx Wealth Tier" and Altrata Data Services, "Dossier
  Category (Wealth Tier)": how the tier is exposed in the platform.
- Wealth-X, "Dossier Classifications (VHNW)": the one-tier-per-profile rule and the
  higher-tier-wins rule.
- Leadership Extractor space, "Leadership Extractor Home" and Team Tensor, "Success For
  Leadership Scraping", "Leadership Extractor WebScraping Options": what LE does, the
  universe size, the cost target and the failure thresholds.
- Research & Data, "Annual Report Update (ARX Tool + ChatGPT) - Process Workflow": the ARX
  research workflow, the document set and the 18-month validation rule. Altrata
  Intelligence, "ADR-1: Annual Report Extractor SPA hosting": the ARX stack.
- Altrata Intelligence, "AIPB Product Requirements" and Client Product, "GTM Strategy -
  Altrata Express Build": what AIPB is for commercially.
- WE Data, "522 - Person Identity Pipeline (PIP)": how address, phone and email master
  tables are refreshed against name, alternate name, date of birth and gender.
- WE Data, "Contact Info Pipeline for (Address, Email & Phone) - NeuStar Vendor data": the
  bought contact file, its volumes and its PII marking.
- Altrata Architecture, "PII Restricted Packages-Data feed" and "Data Feed - Personal
  Address": the Core, NoPII and NoContactData packages, and the fifty-address display cap.
- Altrata Standards, "Individual Data Opt Out Standards" and "Data Privacy & Compliance
  Standards": removal versus suppression, and the thirty-day target.
- Data Product Management, "Privacy & Compliance": the US state patchwork, the CCPA and
  CPRA position, and how the right to be forgotten differs between regimes.
