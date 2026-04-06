# Scheduling Algorithm

This document summarizes the current scheduling behavior in Labby.

## Mathematical and Informatics Principles

- The scheduling problem is a constrained combinatorial optimization problem.
- Exact global optimization is expensive for interactive use, so the solver uses heuristic search.
- Labby uses simulated annealing: it accepts all better moves and sometimes worse moves with probability

$$
P(\text{accept}) = e^{-\Delta / T}
$$

where $\Delta$ is cost increase and $T$ decreases over iterations.

## Scope

- Solver implementation: packages/core/src/schedule/annealing.ts and packages/core/src/schedule/index.ts
- This document covers scheduling only.
- Similarity supervision and projection are documented in docs/algorithm-similarity.md.

## What the Solver Does

The solver generates seminar sessions in two modes:

- full scheduling: build all sessions from scratch
- incremental scheduling: keep sessions before changeDate, rebuild the rest

## Inputs

- active persons (disabled persons are excluded)
- schedule config: date range, weekdays, presenter/questioner counts, target similarity radius
- person unavailabilities
- keyword similarity map for presenter-questioner relevance
- optional constraints
- previous plan + changeDate (incremental mode)

## Pipeline

1. Generate session dates in UTC and keep configured weekdays.
2. Build an availability-aware initial schedule.
3. Improve the plan with local search (simulated annealing).
4. Return the lowest-cost schedule found.

## Initial Assignment Rules

Presenter selection priority:

- fewer past presenter assignments
- fewer total role assignments
- longer time since last presentation
- random tie-breaker

Questioner selection priority:

- fewer past questioner assignments
- fewer total role assignments
- lower same-session questioner load
- fewer repeated presenter-questioner pairs
- similarity closer to target radius
- random tie-breaker

Hard validity rules:

- presenter cannot be their own questioner
- duplicate questioners in one presentation are not allowed
- if candidate pool is too small, fewer questioners are allowed

Availability rule:

- people marked unavailable on a date are filtered out for both presenter and questioner assignment

## Cost Function (Lower Is Better)

Main penalty groups:

- presentation gap unevenness
- repeated questioner-presenter pairs (grows quickly)
- relevance mismatch to target radius
- fairness variance (presenter count, questioner count, total role count)
- invalid assignments (very large penalty)
- optional constraint penalties/rewards

Implementation detail:

- repeated pair penalty grows exponentially with frequency
- invalid assignments use large hard penalties to keep search in valid regions

Current optional constraints:

- no-overlap
- affinity-boost

## Search Strategy

Neighbor operations during annealing:

- swap presenters across sessions
- rebuild one presentation's questioner list

Acceptance:

- always accept lower-cost neighbors
- sometimes accept higher-cost neighbors early, less often later

This helps avoid poor local minima while converging over time.

## Incremental Scheduling Behavior

- sessions before changeDate are frozen
- sessions on/after changeDate are mutable
- frozen sessions still count for fairness and pair-frequency history
- additional Hamming penalty discourages unnecessary presenter churn

Default date guidance and warning behavior:

- recommended incremental changeDate is today + 7 days
- the start date is inclusive: changeDate itself is part of the mutable set
- if changeDate is earlier than the recommended default, UI shows a warning but does not block execution
- full re-run can also show the same non-blocking warning when the configuration start date is earlier than the recommended default

Hamming term meaning:

- it penalizes changed (date, presenter) pairs between old mutable part and new mutable part

## Metrics and Human-readable Explanations

Each solve operation can return objective metrics and explanations:

- `uniformityPenalty`
- `questionerPenalty`
- `relevancePenalty`
- `presenterLoadPenalty`
- `questionerLoadPenalty`
- `totalRolePenalty`
- `invalidAssignmentPenalty`
- `constraintPenalty`
- `totalCost`

The server also exposes a metrics endpoint for:

- one full history plan
- one specific session date inside a plan

Explanations are plain-language summaries for each metric item.

## Temporary Session Insert/Delete (History-local)

Temporary operations apply to the current history chain only (new snapshot), not to config defaults.

Supported strategies:

- shift: apply insertion/deletion by shifting session sequence
- in-place replan: mutate only the selected index locally

These operations are intentionally non-destructive to previous history snapshots.

## Edge Cases

- if everyone is unavailable for a date, that session is empty
- if available presenters are too few, session presentation count is reduced
- if valid questioners are too few, questioner count is reduced instead of forcing invalid assignments
