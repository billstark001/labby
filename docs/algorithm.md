# Scheduling Algorithm

This document describes the scheduling logic used by Labby.

## Overview

Labby generates seminar schedules in two modes:

- Full scheduling: build a new plan from scratch.
- Incremental scheduling: keep sessions before a change date fixed and re-plan the rest.

The solver lives in `packages/core/src/solver.ts` and combines:

- deterministic date generation
- availability-aware initial assignment
- local search with simulated annealing
- fairness, relevance, and constraint penalties in the cost function

## Inputs

The solver uses these inputs:

- active persons: disabled persons are excluded
- keyword similarity map: used to estimate topic relevance between presenter and questioner
- schedule config: meeting days, date range, presenter count, questioner count, and target similarity radius
- unavailabilities: date ranges where a person cannot present or ask questions
- optional scheduling constraints
- previous plan and change date: only for incremental scheduling

## Session Dates

The solver first expands the configured date range into session dates.

- Dates are generated in UTC.
- Only weekdays listed in `daysOfWeek` are kept.
- The result is a stable list of `YYYY-MM-DD` strings.

## Initial Assignment

The initial schedule is not purely random.

### Presenter assignment

For each session, the solver selects available presenters with these priorities:

- fewer past presenter assignments first
- fewer total role assignments first
- longer time since last presentation first
- random tie-breaker

This keeps presentation counts as even as possible from the beginning.

### Questioner assignment

For each presentation, the solver selects questioners from the available non-presenters.

Questioners are ranked by:

- fewer past questioner assignments first
- fewer total role assignments first
- lower questioner load in the current session first
- fewer repeated presenter-questioner pairs first
- similarity closer to the configured target radius first
- random tie-breaker

Important behavior:

- a presenter is never assigned as their own questioner
- duplicate questioners for one presentation are avoided
- if there are not enough valid candidates, the solver returns fewer questioners
- an empty questioner list is allowed

## Cost Function

The solver evaluates schedules with a weighted cost function.

Lower cost is better.

### 1. Presentation uniformity

For each person, the solver looks at the gaps between their presentation sessions.

- small variance in gaps is preferred
- very uneven spacing is penalized

### 2. Repeated questioner-presenter pairs

If the same person questions the same presenter multiple times, the penalty grows exponentially.

This pushes the schedule toward more diverse interactions.

### 3. Domain relevance

For each presenter-questioner pair, the solver computes keyword similarity.

- similarity is estimated from the person keyword sets
- the penalty is the distance between actual similarity and the configured target radius

This allows the schedule to prefer questioners who are neither too close nor too far from the presenter, depending on the chosen target.

### 4. Fairness penalties

The solver also penalizes uneven role counts.

- presenter count variance across all active people
- questioner count variance across all active people
- total role count variance across all active people

These penalties help keep workloads low and balanced.

### 5. Invalid assignments

The solver applies a very large penalty when a schedule contains invalid questioner assignments.

Examples:

- presenter appears in their own questioner list
- duplicated questioners in one presentation

In practice, the mutation step also repairs these cases directly.

### 6. Constraint penalties

The solver also supports optional explicit constraints.

Current constraint types:

- `no-overlap`: penalizes cases where members of the same configured group appear as presenter and questioner in the same presentation
- `affinity-boost`: rewards pairings where members of the same configured group appear together in one presentation

These constraints are evaluated inside the cost function together with the fairness and relevance penalties.

## Search Strategy

After the initial schedule is built, Labby improves it with simulated annealing.

Each iteration creates a neighboring schedule by doing one of these actions:

- swap two presenters across sessions
- rebuild the questioner list of one presentation

After a presenter swap, the affected presentations are repaired immediately so that:

- self-questioning cannot remain
- unavailable users are excluded
- questioners are reassigned with the same fairness rules used in initialization

The annealing loop accepts:

- all lower-cost neighbors
- some higher-cost neighbors with a probability that decreases over time

This helps escape local minima early and stabilize later.

## Incremental Scheduling

Incremental scheduling reuses the existing plan.

- sessions before `changeDate` stay frozen
- sessions on or after `changeDate` are rebuilt
- frozen sessions are included in fairness and pair-frequency accounting

The incremental solver also adds a Hamming penalty.

- it compares the new mutable part with the old mutable part
- changing fewer presenter assignments gives a lower penalty

This reduces schedule churn after small updates.

## Server Endpoints

In API-backed mode, the server exposes the solver through these routes:

- `POST /api/v1/solver/run`: full scheduling
- `POST /api/v1/solver/run-incremental`: incremental scheduling from a `changeDate`

Both routes load persons, similarities, configs, and unavailabilities from server storage before calling the core solver.

The API also exposes keyword-learning support through:

- `POST /api/v1/nlp/update-similarity`

This endpoint applies one triplet-learning step, recomputes the similarity graph, and persists the updated weights.

## Practical Notes

- If everyone is unavailable on a session date, the session becomes empty.
- If the available pool is too small, the number of presentations in that session is reduced.
- If questioner demand is larger than the valid candidate pool, the solver uses fewer questioners instead of creating invalid assignments.

## Summary

The current algorithm aims to produce schedules that are:

- availability-aware
- fair across presenters and questioners
- diverse in interaction patterns
- aligned with keyword similarity goals
- aware of configured constraints
- stable under incremental changes
