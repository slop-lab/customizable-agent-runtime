import { randomUUID } from "node:crypto";

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(): string;
}

export const systemClock: Clock = { now: () => new Date().toISOString() };
export const randomIds: IdGenerator = { next: () => randomUUID() };

export interface RuntimeSystem {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export const defaultRuntimeSystem: RuntimeSystem = {
  clock: systemClock,
  ids: randomIds,
};
