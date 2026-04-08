/**
 * src/pulse/index.ts
 * Assembles all Pulse plugin components into the pulsePlugin object.
 *
 * Grows each day:
 *   Day 4: services (PulseBackgroundService)
 *   Day 5: actions (ProcessEmailsAction), events
 *   Day 6: evaluators (SlibGuardEvaluator)
 *   Day 7: actions (DetectConflictsAction), routes
 *   Day 9: providers, tests
 */

import type { Plugin } from "@elizaos/core";
import { PulseBackgroundService } from "./services/PulseBackgroundService.js";

export const pulsePlugin: Plugin = {
  name: "pulse",
  description:
    "Pulse — Autonomous Chief of Staff. " +
    "Runs background processing on Nosana GPU, reads Gmail and Google Calendar via MCP, " +
    "tracks commitments with Slib Guard, and presents an action approval queue " +
    "for every proposed action. Nothing is auto-sent — the user decides.",

  // ── Services ────────────────────────────────────────────────────────────────
  // PulseBackgroundService starts on plugin init and runs every 6 hours.
  services: [PulseBackgroundService],

  // ── Filled in on subsequent days ────────────────────────────────────────────
  actions: [],
  providers: [],
  evaluators: [],
  routes: [],
  tests: [],
};

export default pulsePlugin;
