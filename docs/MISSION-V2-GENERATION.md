# Mission & Question Generation V2 Pipeline

## Overview
Mission and Question Generation V2 provides a strictly deterministic server-side publication pipeline for AI-generated missions and exercises in LinuxForge Core V50.

AI-generated content is advisory and untrusted. No exercise is published or exposed to learners as an executable mission without passing through all seven validation gates.

## The 7-Gate Validation Pipeline

```
Candidate Exercise (AdaptiveExercise)
           ↓
   Gate 1: SCHEMA VALIDATE
           ↓ (title/scenario/objective length, approved sourceRefs, command bounds)
   Gate 2: ENVIRONMENT VALIDATE
           ↓ (structured capabilities check: packages, services, processes, networking)
   Gate 3: OBJECTIVE VALIDATE
           ↓ (measures blueprint objective shape, primary skill, concrete tasks)
   Gate 4: VERIFIER VALIDATE
           ↓ (converts to executable Contract, verify() function verified)
   Gate 5: DIFFICULTY VALIDATE
           ↓ (1 <= difficulty <= 5, aligned with blueprint)
   Gate 6: PREREQUISITE VALIDATE
           ↓ (deterministic validation against canonical SKILL_GRAPH)
   Gate 7: CONTINUITY VALIDATE
           ↓ (generic scenario artifacts & required prior references verified)
   Bounded Repair or Reject (max 2 deterministic structural repairs)
           ↓
   Publish Validated Mission & Deterministic Contract
```

## Structured Rejection Codes

- `SCHEMA_INVALID`: Exercise fails baseline structural, length, command, or approved source reference constraints.
- `ENVIRONMENT_UNSUPPORTED`: Exercise requires unsupported capabilities (e.g., packages, services, processes, networking, or unverified privileges).
- `OBJECTIVE_INVALID`: Stated objective does not align with blueprint primary skill or evaluation plan does not measure the stated objective.
- `VERIFIER_UNSUPPORTED`: Evaluation plan cannot be compiled into a deterministic verifier Contract.
- `DIFFICULTY_INVALID`: Difficulty is out of bounds (1–5) or deviates unacceptably from blueprint.
- `PREREQUISITE_INVALID`: Circular or inconsistent prerequisites detected.
- `CONTINUITY_INVALID`: Exercise depends on previous scenario artifacts absent from structured scenario context.

## Deterministic Bounded Repair

- Maximum of 2 repair attempts.
- Permitted repairs: string sanitization/trimming, float-to-integer difficulty normalization, relative path prefix cleaning (`/home/learner/` stripping), skill deduplication.
- Forbidden repairs: inventing commands, packages, services, files, permissions, network access, or runtime capabilities.
