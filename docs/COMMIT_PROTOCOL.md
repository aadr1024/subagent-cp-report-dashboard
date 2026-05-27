# Commit Protocol

This repo should use small, frequent commits with detailed messages.

## Scope

Commit only software infrastructure and documentation:

- dashboard server code
- runner/writer code
- frontend code
- workflow documentation
- implementation notes

Do not commit:

- source photos
- original reports
- generated DOCX reports
- run folders
- thumbnail caches
- API logs/payloads
- local secrets

## Message style

Use Conventional Commit prefixes:

- `feat:` for new user-visible capability
- `fix:` for behavior corrections
- `docs:` for documentation/context
- `refactor:` for structure-only changes
- `perf:` for speed/resource improvements
- `chore:` for repo/tooling maintenance

Prefer long commit bodies with headings:

- `Summary`
- `User-facing behavior`
- `Implementation details`
- `Safety/data boundaries`
- `Follow-ups`

## Frequency

Commit after each coherent slice:

- one UI behavior
- one backend endpoint
- one writer/runner behavior
- one observability improvement
- one documentation update

Avoid bundling unrelated fixes.

