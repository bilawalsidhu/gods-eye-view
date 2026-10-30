---
name: spec-workflow
description: "Turn feature requirements and an implementation plan into a clarified requirements, plan, and validation checklist. Use when: creating an implementation specification, preparing acceptance criteria, planning feature work, or asking what must be validated before coding."
---

# Spec Workflow

Create a specification checklist from feature requirements without implementing or committing code.

## Workflow

### 1. Establish the feature scope

Read the supplied requirements and implementation plan. If the user did not specify a feature name and a destination for the specification, ask for both before continuing. Prefer a workspace path such as `specs/<feature-name>.md`.

Do not invent missing requirements, policies, users, platforms, data behavior, or success criteria. Separate:

- stated requirements;
- inferred implications that need confirmation;
- unknowns that require a decision.

### 2. Identify assumptions and decisions

Review the requirements for ambiguity across these areas:

- users and personas;
- supported platforms and viewport sizes;
- scope and explicit exclusions;
- data sources, freshness, limits, and failure states;
- security, privacy, permissions, and persistence;
- expected behavior for empty, loading, stale, and error states;
- accessibility, localization, and keyboard interaction;
- performance targets;
- observability and analytics;
- compatibility with existing APIs and storage;
- lifecycle: creation, updates, deletion, cancellation, and teardown;
- manual and automated validation evidence;
- migration or rollout requirements.

Ask questions for unresolved assumptions. Prefer a small number of grouped questions in the available question UI. Include proposed options when the choice is finite, but never treat a recommendation as a decision.

Continue only when the user answers the blocking questions or explicitly says to mark them unresolved. Keep non-blocking unknowns visible in the Decisions table instead of silently choosing defaults.

### 3. Write the specification

Create or update the requested specification file. The document must contain exactly these major sections, in this order:

```markdown
# <Feature Name> Specification

## Requirements

### Decisions

| Decision | Options considered | Selected option | Owner | Status |
|---|---|---|---|---|

### Acceptance Criteria

- [ ] ...

## Plan

- [ ] ...

## Validation

- [ ] ...
```

Use Markdown checkboxes for requirements, plan items, and validation items.

### Requirements

Requirements are testable acceptance criteria. Begin with decisions that affect the criteria.

Each acceptance criterion should:

- describe observable behavior;
- identify the relevant user or system actor;
- avoid prescribing an implementation unless the implementation is a stated constraint;
- include success and relevant failure behavior where necessary;
- use one checkbox per independently verifiable outcome.

Group criteria under short headings when it improves scanning. Keep headings within the three required sections.

Do not add implementation tasks to Requirements. Use Plan for sequencing and Validation for verification.

### Decisions table

Include every assumption that could materially change behavior, architecture, scope, cost, risk, or validation. Record options, the selected option, owner, and status.

Use these statuses:

- `Decided` — the user has chosen or explicitly confirmed it;
- `Proposed` — an option is recommended but not yet approved;
- `Blocked` — required information is missing and prevents reliable planning;
- `Out of scope` — explicitly excluded.

Never claim a choice was made by the user unless it appears in the conversation. If unresolved, ask again or leave the status `Blocked` rather than substituting an assumption.

### Plan

Turn the approved requirements into a checklist of implementation steps. Keep plan items outcome-oriented and ordered where dependencies matter.

Include, as applicable:

- contracts and data models;
- integrations and lifecycle hooks;
- pure logic before UI or rendering work;
- UI states and accessibility;
- automated test creation;
- focused validation commands;
- repository-specific feature gates or browser checks;
- documentation or localization updates;
- cleanup and teardown.

Do not mark implementation items complete before the user confirms or automated work verifies them.

### Validation

Validation is both an automated and manual checklist. Include:

- setup or preconditions;
- happy-path manual test cases;
- relevant empty, error, stale, permission, and teardown cases;
- keyboard, focus, responsive, and accessibility checks where applicable;
- automated unit, integration, boundary, build, lint, and feature-gate checks;
- expected observable result for each case;
- known environment constraints, credentials, or live-service dependencies.

Validation items should not duplicate implementation steps. Each item should state what will be checked and what result proves success.

## 4. Preserve ambiguity explicitly

Do not replace an unanswered question with common practice or a reasonable default. If the user asks to proceed despite unknowns, mark the affected decisions as `Blocked` and exclude unsupported behavior from acceptance criteria when possible.

Avoid weak criteria such as:

- "works correctly";
- "is responsive";
- "handles errors";
- "is performant";
- "supports edge cases".

Replace them with observable behavior or a numeric target confirmed by the user or repository constraints.

## 5. Review and refine

After writing the file:

1. summarize what was decided and what remains blocked;
2. identify the most ambiguous acceptance criteria;
3. ask focused follow-up questions for unresolved decisions;
4. update the specification until the user accepts it or explicitly keeps items blocked.

When implementation guidance is also requested, keep it in the Plan section. This skill does not implement that plan unless the user separately asks it to.

## Interaction and safety constraints

- **Never implement feature code while running this specification workflow**, unless the user separately requests implementation.
- **Never commit code, create commits, stage changes, or create pull requests.**
- **Never git push, rebase, merge, or amend.**
- Editing the specification file itself is allowed and is not implementation work.
- Run read-only repository searches when they are needed to identify existing architecture or validation conventions.
- Ask before destructive operations or commands that could modify user work.
- Do not claim tests passed unless they were actually run and reported.
- Do not mark checkboxes complete in the specification during planning; checkboxes represent required work unless the user supplied completed-state evidence.

## Output

Return the specification path and a concise summary containing:

- key decisions confirmed;
- unresolved or blocked decisions;
- ambiguous acceptance criteria;
- suggested next questions or approvals;
- confirmation that no code was implemented and no commit was created.

The specification must remain concise enough to review, while covering every blocking assumption and every acceptance criterion needed to start implementation.
