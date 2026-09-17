import type { TraceEvent } from '@harness-code/core';

export interface GraderSpec {
  name: string;
  [option: string]: unknown;
}

export interface GraderContext {
  /** The task's pristine fixture. */
  fixtureDir: string;
  /** The post-run workspace. */
  workDir: string;
  /** This run's trace events (from its last `run_start`). */
  events: TraceEvent[];
}

export interface GraderResult {
  passed: boolean;
  detail: string;
}

export type Grader = (ctx: GraderContext, options: GraderSpec) => Promise<GraderResult>;

export function numberOpt(spec: GraderSpec, key: string, fallback: number): number {
  const v = spec[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function stringsOpt(spec: GraderSpec, key: string, fallback: string[] = []): string[] {
  const v = spec[key];
  return Array.isArray(v) ? v.map(String) : fallback;
}
