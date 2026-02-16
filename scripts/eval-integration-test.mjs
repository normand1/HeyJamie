#!/usr/bin/env node

/**
 * Evaluates a HeyJamie integration test log against an expected-actions file.
 *
 * Usage:
 *   node scripts/eval-integration-test.mjs \
 *     --log heyjamie-integration-test.log \
 *     --expectations docs/eval-expectations/topic-changes.json \
 *     [--output eval-report.json]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { log: null, expectations: null, output: null };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--log":
        args.log = argv[++i];
        break;
      case "--expectations":
        args.expectations = argv[++i];
        break;
      case "--output":
        args.output = argv[++i];
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(2);
    }
  }
  if (!args.log || !args.expectations) {
    console.error("Usage: eval-integration-test.mjs --log <log-file> --expectations <expectations-file> [--output <report-file>]");
    process.exit(2);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Log file parsing
// ---------------------------------------------------------------------------

function parseLogFile(logPath) {
  const raw = readFileSync(resolve(logPath), "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const events = [];
  for (const line of lines) {
    if (line.startsWith("#")) continue; // skip header comment
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip unparseable lines
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Relative timing
// ---------------------------------------------------------------------------

function addRelativeTimings(events) {
  const runStart = events.find((e) => e.event === "run-start");
  if (!runStart) return { runStartTs: null, events };
  const runStartMs = new Date(runStart.ts).getTime();
  for (const ev of events) {
    ev._relativeMs = new Date(ev.ts).getTime() - runStartMs;
    ev._relativeSec = ev._relativeMs / 1000;
  }
  return { runStartTs: runStart.ts, runStartMs, events };
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function strContains(haystack, needle) {
  if (typeof haystack !== "string" || typeof needle !== "string") return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function matchEvent(event, criteria) {
  for (const [key, expected] of Object.entries(criteria)) {
    switch (key) {
      case "triggerReason":
      case "suggestionType":
        if (event[key] !== expected) return false;
        break;
      case "ok":
        if (event.ok !== expected) return false;
        break;
      case "browserosRunIndex":
        if (event.browserosRunIndex !== expected) return false;
        break;
      case "queryContains":
        if (!strContains(event.query, expected)) return false;
        break;
      case "queryPattern":
        if (!new RegExp(expected, "i").test(event.query ?? "")) return false;
        break;
      case "startUrlContains":
        if (!strContains(event.startUrl, expected)) return false;
        break;
      case "endUrlContains":
        if (!strContains(event.endUrl, expected)) return false;
        break;
      case "urlContains":
        if (!strContains(event.startUrl, expected) && !strContains(event.endUrl, expected))
          return false;
        break;
      case "directCommandContains":
        if (!strContains(event.directCommand, expected)) return false;
        break;
      case "utteranceIndexRange": {
        const idx = event.triggerUtteranceIndex;
        if (typeof idx !== "number" || idx < expected[0] || idx > expected[1]) return false;
        break;
      }
      case "actionsContain": {
        if (!Array.isArray(event.actions)) return false;
        for (const needle of expected) {
          if (!event.actions.some((a) => strContains(a, needle))) return false;
        }
        break;
      }
      case "diagramUrlContains":
        if (!strContains(event.diagramUrl, expected)) return false;
        break;
      case "excalidrawPromptContains":
        if (!strContains(event.excalidrawPrompt, expected)) return false;
        break;
      case "contentSnapshotContains":
        if (!strContains(event.contentSnapshot, expected)) return false;
        break;
      default:
        // Unknown criteria key — skip
        break;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Expectation evaluation
// ---------------------------------------------------------------------------

function evaluateExpectation(expectation, events) {
  const { id, event: eventType, match, timing } = expectation;

  // Filter events by type
  const candidates = events.filter((e) => e.event === eventType);

  // Apply match criteria
  const matched = candidates.filter((e) => matchEvent(e, match));

  if (matched.length === 0) {
    const matchDesc = Object.entries(match)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    return {
      id,
      status: "missing",
      score: 0.0,
      reason: `No log events matched: event=${eventType}, ${matchDesc}`,
    };
  }

  // Check timing on matched events
  if (timing) {
    const inWindow = matched.filter((e) => {
      const sec = e._relativeSec;
      if (timing.afterSec != null && sec < timing.afterSec) return false;
      if (timing.beforeSec != null && sec > timing.beforeSec) return false;
      return true;
    });

    if (inWindow.length > 0) {
      const best = inWindow[0];
      return {
        id,
        status: "correct",
        score: 1.0,
        actualTimingSec: round2(best._relativeSec),
        timingWindow: timing,
        matchedEvent: summarizeEvent(best),
      };
    }

    // Matched criteria but outside timing window
    const closest = matched.reduce((a, b) =>
      Math.abs(a._relativeSec - midpoint(timing)) < Math.abs(b._relativeSec - midpoint(timing))
        ? a
        : b
    );
    return {
      id,
      status: "correct-timing-off",
      score: 0.5,
      actualTimingSec: round2(closest._relativeSec),
      timingWindow: timing,
      reason: `Event matched criteria but occurred at ${round2(closest._relativeSec)}s (window: ${timing.afterSec}-${timing.beforeSec}s)`,
      matchedEvent: summarizeEvent(closest),
    };
  }

  // No timing constraint — match alone is sufficient
  const best = matched[0];
  return {
    id,
    status: "correct",
    score: 1.0,
    actualTimingSec: round2(best._relativeSec),
    matchedEvent: summarizeEvent(best),
  };
}

// ---------------------------------------------------------------------------
// Summary evaluation
// ---------------------------------------------------------------------------

function evaluateSummary(summaryExpectations, events) {
  const result = {};

  if (summaryExpectations.runComplete) {
    const runComplete = events.find((e) => e.event === "run-complete");
    if (!runComplete) {
      result.runComplete = { error: "No run-complete event found in log" };
    } else {
      const rc = summaryExpectations.runComplete;
      result.runComplete = {};

      if (rc.status != null) {
        result.runComplete.status = {
          expected: rc.status,
          actual: runComplete.status,
          correct: runComplete.status === rc.status,
        };
      }

      for (const field of ["browserosRunsStarted", "browserosRunsSucceeded", "browserosRunsFailed", "excalidrawRunsStarted", "excalidrawRunsSucceeded", "excalidrawRunsFailed"]) {
        if (rc[field] != null) {
          const actual = runComplete[field];
          const expected = rc[field];
          let correct = true;
          if (expected.min != null && actual < expected.min) correct = false;
          if (expected.max != null && actual > expected.max) correct = false;
          result.runComplete[field] = { expected, actual, correct };
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// LLM summary generation
// ---------------------------------------------------------------------------

function generateLlmSummary(transcriptId, score, maxScore, scorePercent, breakdown, expectationResults, summaryResult) {
  const parts = [];
  parts.push(`${transcriptId} eval: ${score}/${maxScore} (${scorePercent}%).`);
  parts.push(`${breakdown.correct} correct, ${breakdown.correctTimingOff} timing-off, ${breakdown.missing} missing.`);

  // List missing expectations
  const missing = expectationResults.filter((e) => e.status === "missing");
  if (missing.length > 0) {
    parts.push(`Missing: ${missing.map((m) => m.id).join(", ")}.`);
  }

  // List timing-off expectations
  const timingOff = expectationResults.filter((e) => e.status === "correct-timing-off");
  if (timingOff.length > 0) {
    parts.push(`Timing off: ${timingOff.map((t) => `${t.id} (${t.actualTimingSec}s)`).join(", ")}.`);
  }

  // Summary
  if (summaryResult.runComplete) {
    const rc = summaryResult.runComplete;
    if (rc.error) {
      parts.push(`Run summary: ${rc.error}.`);
    } else {
      const fields = Object.entries(rc)
        .filter(([, v]) => v && typeof v === "object" && "correct" in v)
        .map(([k, v]) => `${k}=${v.actual}${v.correct ? "" : " (UNEXPECTED)"}`)
        .join(", ");
      parts.push(`Run summary: ${fields}.`);
    }
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function round2(n) {
  return Math.round(n * 100) / 100;
}

function midpoint(timing) {
  const a = timing.afterSec ?? 0;
  const b = timing.beforeSec ?? a + 60;
  return (a + b) / 2;
}

function summarizeEvent(event) {
  const summary = { event: event.event };
  const keepFields = [
    "ts", "triggerReason", "triggerUtterance", "triggerUtteranceIndex",
    "suggestionType", "query", "startUrl", "endUrl", "ok", "message",
    "browserosRunIndex", "directCommand", "status",
    "browserosRunsStarted", "browserosRunsSucceeded", "browserosRunsFailed",
    "excalidrawRunsStarted", "excalidrawRunsSucceeded", "excalidrawRunsFailed",
    "diagramUrl", "excalidrawPrompt", "plannerSource",
  ];
  for (const f of keepFields) {
    if (event[f] !== undefined) summary[f] = event[f];
  }
  // Include actions array length but not full content (can be long)
  if (Array.isArray(event.actions)) {
    summary.actionsCount = event.actions.length;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);

  // Load files
  let events;
  try {
    events = parseLogFile(args.log);
  } catch (err) {
    console.error(`Error reading log file: ${err.message}`);
    process.exit(2);
  }

  let expectations;
  try {
    expectations = JSON.parse(readFileSync(resolve(args.expectations), "utf-8"));
  } catch (err) {
    console.error(`Error reading expectations file: ${err.message}`);
    process.exit(2);
  }

  if (expectations.schemaVersion !== 2) {
    console.error(`Unsupported schema version: ${expectations.schemaVersion} (expected 2)`);
    process.exit(2);
  }

  // Compute relative timings
  const { runStartTs, events: timedEvents } = addRelativeTimings(events);
  if (!runStartTs) {
    console.error("No run-start event found in log file");
    process.exit(2);
  }

  // Find run-complete for duration
  const runComplete = timedEvents.find((e) => e.event === "run-complete");
  const runDurationSec = runComplete ? round2(runComplete._relativeSec) : null;

  // Evaluate each expectation
  const expectationResults = expectations.expectations.map((exp) =>
    evaluateExpectation(exp, timedEvents)
  );

  // Compute score
  const score = round2(expectationResults.reduce((sum, r) => sum + r.score, 0));
  const maxScore = expectationResults.length;
  const scorePercent = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;

  const breakdown = {
    correct: expectationResults.filter((r) => r.status === "correct").length,
    correctTimingOff: expectationResults.filter((r) => r.status === "correct-timing-off").length,
    missing: expectationResults.filter((r) => r.status === "missing").length,
    total: maxScore,
  };

  // Evaluate summary
  const summaryResult = expectations.summary
    ? evaluateSummary(expectations.summary, timedEvents)
    : {};

  // Generate LLM summary
  const llmSummary = generateLlmSummary(
    expectations.transcriptId,
    score, maxScore, scorePercent,
    breakdown, expectationResults, summaryResult
  );

  // Build report
  const report = {
    evalVersion: 1,
    timestamp: new Date().toISOString(),
    logFile: args.log,
    expectationsFile: args.expectations,
    transcriptId: expectations.transcriptId,
    runStartTs,
    runDurationSec,
    score,
    maxScore,
    scorePercent,
    breakdown,
    expectations: expectationResults,
    summary: summaryResult,
    llmSummary,
  };

  const reportJson = JSON.stringify(report, null, 2);

  if (args.output) {
    writeFileSync(resolve(args.output), reportJson + "\n", "utf-8");
    console.log(`Report written to ${args.output}`);
  }

  // Always print summary to stdout
  console.log("");
  console.log(`=== HeyJamie Integration Test Eval ===`);
  console.log(`Transcript: ${expectations.transcriptId}`);
  console.log(`Score: ${score}/${maxScore} (${scorePercent}%)`);
  console.log(`Breakdown: ${breakdown.correct} correct, ${breakdown.correctTimingOff} timing-off, ${breakdown.missing} missing`);
  console.log("");

  for (const r of expectationResults) {
    const icon = r.status === "correct" ? "+" : r.status === "correct-timing-off" ? "~" : "-";
    const timing = r.actualTimingSec != null ? ` @ ${r.actualTimingSec}s` : "";
    const extra = r.reason ? ` -- ${r.reason}` : "";
    console.log(`  [${icon}] ${r.id} (${r.score})${timing}${extra}`);
  }

  console.log("");
  console.log(`LLM Summary: ${llmSummary}`);
  console.log("");
}

main();
