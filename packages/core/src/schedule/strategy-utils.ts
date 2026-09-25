import type { ScheduleConfig, Session } from '../types.js';
import type { ConstraintGuidance, CostContext } from './constraints.js';

export type RandomSource = () => number;
export type QuestionerPicker = (presenterId: string, date: string, count: number) => string[];

export interface StrategyContext {
  sessions: Session[];
  historicalSessions: Session[];
  personIds: string[];
  cost: CostContext;
  guidance: ConstraintGuidance;
  config: ScheduleConfig;
  unavailable: Map<string, Set<string>>;
  pickQuestioners: QuestionerPicker;
  random: RandomSource;
}

export function cloneSessions(sessions: Session[]): Session[] {
  return sessions.map(session => ({
    date: session.date,
    presentations: session.presentations.map(presentation => ({
      presenterId: presentation.presenterId,
      questionerIds: [...presentation.questionerIds],
    })),
  }));
}

export function hammingDistance(a: Session[], b: Session[]): number {
  const mapB = new Map(b.map(session => [session.date, new Set(session.presentations.map(presentation => presentation.presenterId))]));
  let difference = 0;
  for (const session of a) {
    const presenters = mapB.get(session.date);
    if (!presenters) { difference += session.presentations.length; continue; }
    for (const presentation of session.presentations) if (!presenters.has(presentation.presenterId)) difference++;
  }
  return difference;
}

export function presenterCounts(sessions: Session[], personIds: string[]): Map<string, number> {
  const counts = new Map(personIds.map(id => [id, 0]));
  for (const session of sessions) for (const presentation of session.presentations)
    counts.set(presentation.presenterId, (counts.get(presentation.presenterId) ?? 0) + 1);
  return counts;
}

export function expectedPresenterCounts(
  total: number, personIds: string[], guidance: ConstraintGuidance,
): Map<string, number> {
  const weights = personIds.map(id => guidance.presenterWeights.get(id) ?? 1);
  const sum = weights.reduce((value, weight) => value + weight, 0);
  return new Map(personIds.map((id, index) => [id,
    sum > 0 ? total * weights[index]! / sum : total / personIds.length]));
}
