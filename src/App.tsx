import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Play,
  Pause,
  Square,
  Mic,
  MicOff,
  AlertTriangle,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  RefreshCw,
  PenTool,
} from "lucide-react";

import {
  DEFAULT_EVALUATION_DELAY_MS,
  DEFAULT_TOPIC_SHIFT_SENSITIVITY,
  hasOpenRouterKey,
  loadOpenRouterSettings,
} from "./openrouter";
import {
  EVALUATION_DELAY_LEVELS,
  TOPIC_SHIFT_SENSITIVITY_LEVELS,
} from "./browserAutomationOptions";
import { getPersonaById, NO_PERSONA_ID, PERSONAS } from "./personas";
import {
  parseMcpConfig,
  summarizeMcpServers,
  type McpServerSummary,
} from "./mcpConfig";
import { addUserNote, loadUserNotes, formatUserNotesForPrompt } from "./userNotes";
import {
  getMockTranscript,
  listMockTranscriptIds,
  splitMockTranscript,
} from "./mockTranscripts";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import { cn } from "./lib/utils";

type SuggestionType = "Search" | "Image" | "Video" | "News";

type Suggestion = {
  id: string;
  type: SuggestionType;
  query: string;
  note: string;
  url?: string;
  rating?: number;
};

type ToolCallDetail = {
  id: string;
  name: string;
  input?: unknown;
  output?: unknown;
};

type SuggestionLogEntry = {
  id: string;
  timestamp: number;
  narrative: string;
  toolCalls: ToolCallDetail[];
  suggestions: Suggestion[];
};

type WhisperStatus = {
  cliFound: boolean;
  modelFound: boolean;
  cliPath?: string | null;
  modelPath?: string | null;
};

type ExcalidrawStatus = {
  dirFound: boolean;
  indexJsFound: boolean;
  serverJsFound: boolean;
  installPath?: string | null;
};

type McpConfigResponse = {
  path: string;
  content: string;
};

type HeyJamieCommand = {
  command: string;
  transcriptLine: string;
  transcriptLineIndex: number;
};

type StatusState = {
  text: string;
  meta: string;
  live: boolean;
};

type TranscriptEntry = {
  id: string;
  text: string;
  timestamp: number;
};

type ChapterSource = "intro" | "topic-shift" | "direct-command" | "url-visit";

type ChapterEntry = {
  id: string;
  title: string;
  timestampMs: number;
  transcriptIndex: number;
  source: ChapterSource;
  urls: string[];
};

type TopicCheckReadiness = {
  hasEnoughContext: boolean;
  newTranscriptWordCount: number;
  newTranscriptCharCount: number;
  sentenceBoundaryCount: number;
  nonEmptyLineCount: number;
  informativeTokenCount: number;
  anchorTokenCount: number;
  hasTopicShiftCue: boolean;
};

type TopicShiftDecision = {
  hasTopicShift: boolean;
  newTopicTokenCount: number;
  newAnchorTopicTokenCount: number;
  sharedTopicTokenCount: number;
  topicNoveltyRatio: number;
  hasTopicShiftByNovelty: boolean;
  hasTopicShiftByStrongNovelty: boolean;
  hasTopicShiftByAnchorIntent: boolean;
  hasTopicShiftByExplicitCue: boolean;
  hasTopicShiftByActiveTopicDivergence: boolean;
  activeTopicOverlapRatio: number | null;
  topicShiftScore: number;
};

type BrowserOSIntentPlannerResponse = {
  ok?: boolean;
  query?: string;
  suggestionType?: string;
  startUrl?: string;
  browserosPrompt?: string;
  browserosSystemPrompt?: string;
  narrative?: string;
  reasoning?: string;
  error?: string;
  modelName?: string;
  modelSource?: string;
  actionType?: "browser" | "excalidraw";
  excalidrawPrompt?: string;
  excalidrawSystemPrompt?: string;
  userNote?: string;
};

type BrowserOSIntentPlan = {
  suggestion: Suggestion;
  narrative: string;
  browserosPrompt: string;
  browserosSystemPrompt: string;
  plannerSource: "llm" | "fallback";
  plannerReasoning: string;
  actionType: "browser" | "excalidraw";
  excalidrawPrompt: string;
  excalidrawSystemPrompt: string;
  userNote: string;
};

type BrowserOSTriggerContext = {
  reason: "direct-command" | "topic-shift";
  utterance?: string;
  utteranceIndex?: number;
};

const OUTPUT_SAMPLE_RATE = 16000;
const SEGMENT_SECONDS = 8;
const MIN_SEGMENT_SECONDS = 2;
const DEFAULT_MIN_SEGMENT_RMS_FOR_TRANSCRIPTION = 0.0025;
const MIN_SEGMENT_RMS_FOR_TRANSCRIPTION = (() => {
  const raw = (
    import.meta.env.VITE_HEYJAMIE_WHISPER_MIN_SEGMENT_RMS ?? ""
  ).trim();
  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
    return parsed;
  }
  return DEFAULT_MIN_SEGMENT_RMS_FOR_TRANSCRIPTION;
})();
const LOG_PREFIX = "[HeyJamie]";
const MAX_SUGGESTION_LOG_ENTRIES = 60;
const MIN_NEW_TOPIC_TOKENS_FOR_LLM_REFRESH = 2;
const MIN_TOPIC_NOVELTY_RATIO_FOR_LLM_REFRESH = 0.55;
const MIN_NEW_TOPIC_TOKENS_FOR_STRONG_SHIFT = 3;
const MIN_TOPIC_NOVELTY_RATIO_FOR_STRONG_SHIFT = 0.42;
const MIN_TOPIC_CHECK_CONTEXT_WORDS = 14;
const MIN_TOPIC_CHECK_CONTEXT_CHARS = 80;
const MIN_TOPIC_CHECK_CONTEXT_INFO_TOKENS = 3;
const MIN_TOPIC_CHECK_CONTEXT_SENTENCE_WORDS = 9;
const MIN_TOPIC_CHECK_CONTEXT_LINES = 2;
const MIN_TOPIC_CHECK_SHIFT_CUE_WORDS = 6;
const MIN_CHAPTER_GAP_MS = 30_000;
const MIN_INITIAL_TOPIC_WORDS = 5;
const MIN_INITIAL_TOPIC_CHARS = 28;
const MIN_INITIAL_TOPIC_INFO_TOKENS = 2;
const MAX_BROWSEROS_TRANSCRIPT_CHARS = 3000;
const BROWSEROS_INTENT_RECENT_LINE_COUNT = 12;
const BROWSEROS_GRACE_PERIOD_MS = 15_000;
const BROWSEROS_INFLIGHT_TOPIC_SHIFT_BOOST = 2;
const MOCK_PLAYBACK_LINE_DELAY_MS = 550;
const mockPlaybackSleepPattern = /^\[\[\s*sleep\s*:\s*(\d{1,6})\s*\]\]$/i;
const topicShiftIntentPattern =
  /\b(show|find|search|look(?:\s+up)?|browse|open|get|give|pull|check|explore|investigate)\b/i;
const explicitTopicShiftPattern =
  /\b(?:switch(?:ing)?(?:\s+topics?)?|change(?:\s+topics?)?|new\s+topic|different\s+(?:topic|subject)|instead(?:\s+of)?|rather\s+than|moving\s+on|next\s+(?:topic|segment)|for\s+the\s+next\s+segment|let'?s\s+talk\s+about|talk\s+about\s+something\s+else)\b/i;
const transcriptSearchIntentPattern =
  /\b(?:show|find|search(?:\s+for)?|look(?:ing)?(?:\s+up)?(?:\s+for)?|browse|open|get|give|pull|check|explore|investigate|watch)\b(?:\s+(?:for|about|on|at))?/i;
const trailingTopicReplacementPattern =
  /\b(?:instead of|rather than)\b[\s\S]*$/i;
const topicNeutralWords = new Set([
  "search",
  "find",
  "look",
  "lookup",
  "browse",
  "open",
  "show",
  "click",
  "get",
  "give",
  "pull",
  "check",
  "explore",
  "investigate",
  "image",
  "images",
  "photo",
  "photos",
  "picture",
  "pictures",
  "pic",
  "pics",
  "video",
  "videos",
  "news",
  "article",
  "articles",
  "result",
  "results",
  "source",
  "sources",
  "cute",
  "funny",
  "best",
  "latest",
  "first",
  "next",
  "another",
  "again",
  "more",
]);

const queryNoiseWords = new Set([
  "you",
  "lets",
  "let's",
  "let",
  "see",
  "start",
  "starting",
  "change",
  "changes",
  "changed",
  "switch",
  "switching",
  "topic",
  "topics",
  "please",
  "now",
  "then",
  "kind",
  "sort",
  "just",
  "maybe",
  "gonna",
  "going",
  "want",
  "wants",
  "wanna",
  "need",
  "needs",
  "like",
  "look",
  "looking",
  "search",
  "find",
  "show",
  "browse",
  "open",
  "get",
  "give",
  "pull",
  "check",
  "explore",
  "investigate",
  "watch",
  "about",
  "for",
  "up",
  "into",
  "onto",
  "something",
  "else",
  "instead",
  "prioritize",
  "prioritise",
  "priority",
  "focus",
  "focused",
  "focusing",
  "emphasize",
  "emphasise",
  "highlight",
]);

const lowerStopWords = new Set([
  "i",
  "we",
  "the",
  "a",
  "an",
  "and",
  "but",
  "or",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "from",
  "by",
  "as",
  "it",
  "this",
  "that",
  "these",
  "those",
]);

const lowSignalWords = new Set([
  "uh",
  "um",
  "hmm",
  "mm",
  "yeah",
  "yep",
  "nope",
  "ok",
  "okay",
  "right",
  "sure",
  "thanks",
  "thank",
  "please",
  "like",
  "just",
  "really",
  "actually",
  "basically",
  "literally",
  "thing",
  "things",
  "stuff",
  "maybe",
  "kind",
  "sort",
  "got",
  "cool",
]);

const heyWakeWordPattern = /\bhey\b/i;
const heyNameAndCommandPattern = /\bhey\b[\s,.-]*([a-z][a-z'-]{1,20})\b([\s\S]*)$/i;
const directCommandImageIntentPattern =
  /\b(image|images|photo|photos|picture|pictures|pic|pics|thumbnail|thumbnails|gallery)\b/i;
const directCommandSelectionPattern = /\b(pick|choose|select|click|open|tap)\b/i;
const directCommandNonImagePattern =
  /\b(article|articles|news|headline|headlines|video|videos|youtube|website|site|link|web(?:\s+result)?s?)\b/i;
const jamieNameVariants = new Set([
  "jamie",
  "jaime",
  "jami",
  "jamy",
  "jayme",
  "jaymi",
  "jaymie",
  "jaimy",
  "jammy",
]);

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function calculateRms(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    sum += buffer[i] * buffer[i];
  }
  return Math.sqrt(sum / buffer.length);
}

function mergeBuffers(chunks: Float32Array[], length: number): Float32Array {
  const result = new Float32Array(length);
  let offset = 0;
  chunks.forEach((chunk) => {
    result.set(chunk, offset);
    offset += chunk.length;
  });
  return result;
}

function downsampleBuffer(
  buffer: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number
): Float32Array {
  if (outputSampleRate === inputSampleRate) return buffer;
  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
      accum += buffer[i];
      count += 1;
    }
    result[offsetResult] = accum / count;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

function truncateText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function isTruthyFlag(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function summarizeBrowserOSActionsForTestLog(actions: unknown): string[] {
  if (!Array.isArray(actions)) return [];
  return actions.slice(0, 12).map((action, index) => {
    if (!action || typeof action !== "object") {
      return `${index + 1}. unknown action`;
    }
    const item = action as Record<string, unknown>;
    const label =
      typeof item.action === "string" && item.action.trim()
        ? item.action.trim()
        : typeof item.type === "string" && item.type.trim()
          ? item.type.trim()
          : "step";
    const detail =
      typeof item.instruction === "string" && item.instruction.trim()
        ? item.instruction.trim()
        : typeof item.reasoning === "string" && item.reasoning.trim()
          ? item.reasoning.trim()
          : typeof item.message === "string" && item.message.trim()
            ? item.message.trim()
            : "";
    const pageUrl =
      typeof item.pageUrl === "string" && item.pageUrl.trim()
        ? item.pageUrl.trim()
        : "";
    const details = [
      `${index + 1}. ${label}`,
      detail ? `detail="${truncateText(detail, 180)}"` : "",
      pageUrl ? `url="${pageUrl}"` : "",
    ].filter(Boolean);
    return details.join(" | ");
  });
}

function formatToolPayload(value: unknown, maxLength = 600) {
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else if (value === undefined) {
    text = "";
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }

  if (text.length > maxLength) {
    return `${text.slice(0, maxLength)}…`;
  }
  return text;
}

function formatLogTimestamp(value: number): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatElapsedTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

function toTitleCase(text: string): string {
  return text
    .split(" ")
    .map((word) => {
      if (!word) return "";
      return `${word[0].toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
}

async function generateChapterTitleViaLLM(
  transcriptContext: string,
  fallbackTitle: string,
  apiKey: string,
  model: string
): Promise<string> {
  if (!apiKey || !model || !transcriptContext.trim()) return fallbackTitle;

  const prompt = [
    "Generate a short, descriptive podcast chapter title (2-6 words) for this segment of conversation.",
    "The title should capture the main topic being discussed in a way that would make sense in a podcast table of contents.",
    "Return ONLY the title text, nothing else. No quotes, no punctuation at the end, no explanation.",
    "",
    `Transcript excerpt:\n${transcriptContext.slice(0, 800)}`,
  ].join("\n");

  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 30,
          temperature: 0.3,
        }),
      }
    );

    if (!response.ok) return fallbackTitle;

    const data = await response.json();
    const title = (data?.choices?.[0]?.message?.content ?? "")
      .replace(/^["']|["']$/g, "")
      .replace(/\.\s*$/, "")
      .trim();
    if (!title || title.length > 80) return fallbackTitle;
    return title;
  } catch {
    return fallbackTitle;
  }
}

function buildChapterTitleFromTranscript(text: string): string {
  const cleaned = stripTranscriptLeadInPhrases(text)
    .replace(/\bhey\s+\w+\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const query = buildSearchQueryFromTranscript(cleaned);
  const base = query || cleaned;
  const sanitized = base
    .replace(/["']/g, "")
    .replace(/[^a-z0-9\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!sanitized) {
    return "Intro";
  }
  return toTitleCase(sanitized);
}

function getTranscriptTexts(entries: TranscriptEntry[]): string[] {
  return entries.map((entry) => entry.text);
}

function extractInformativeTokens(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return new Set<string>();

  const tokens = normalized.split(" ");
  const result = new Set<string>();
  tokens.forEach((token) => {
    const clean = token.replace(/^[-']+|[-']+$/g, "");
    if (!clean) return;
    if (clean.length < 4) return;
    if (/^\d+$/.test(clean)) return;
    if (lowerStopWords.has(clean)) return;
    if (lowSignalWords.has(clean)) return;
    result.add(clean);
  });
  return result;
}

function extractNumericTokens(text: string): Set<string> {
  const matches = text.match(/\b\d[\d,.:/-]*\b/g);
  if (!matches) return new Set<string>();
  const normalized = matches
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replace(/,$/, ""));
  return new Set(normalized);
}

function countNewSetItems(current: Set<string>, previous: Set<string>): number {
  let count = 0;
  current.forEach((item) => {
    if (!previous.has(item)) {
      count += 1;
    }
  });
  return count;
}

function countSharedSetItems(current: Set<string>, previous: Set<string>): number {
  let count = 0;
  current.forEach((item) => {
    if (previous.has(item)) {
      count += 1;
    }
  });
  return count;
}

function countWords(text: string): number {
  const matches = text.match(/[a-z0-9]+(?:['-][a-z0-9]+)*/gi);
  return matches ? matches.length : 0;
}

function countSentenceBoundaries(text: string): number {
  const matches = text.match(/[.!?](?:\s|$)/g);
  return matches ? matches.length : 0;
}

function countNonEmptyLines(text: string): number {
  if (!text.trim()) return 0;
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function extractTopicAnchorTokens(text: string): Set<string> {
  const tokens = extractInformativeTokens(text);
  const anchors = new Set<string>();
  tokens.forEach((token) => {
    if (!topicNeutralWords.has(token)) {
      anchors.add(token);
    }
  });
  return anchors;
}

function splitTranscriptIntoQueryCandidates(text: string): string[] {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean);
  const candidates: string[] = [];

  lines.forEach((line) => {
    const sentenceParts = line
      .split(/[.!?;]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (sentenceParts.length === 0) {
      sentenceParts.push(line);
    }
    sentenceParts.forEach((part) => {
      const clauseParts = part
        .split(/\b(?:and then|then|now)\b/gi)
        .map((clause) => clause.trim())
        .filter(Boolean);
      if (clauseParts.length === 0) {
        clauseParts.push(part);
      }
      candidates.push(...clauseParts);
    });
  });

  return candidates;
}

function stripTranscriptLeadInPhrases(text: string): string {
  let value = text.trim();
  const leadInPatterns = [
    /^(?:you\s+)?let(?:'s| us)?\s+see\s+/i,
    /^(?:you\s+)?(?:okay|ok|alright|all right|well|so|now)\s+/i,
    /^(?:can|could|would)\s+we\s+/i,
    /^i\s+(?:want|need|would\s+like)\s+to\s+/i,
    /^please\s+/i,
    /^(?:please\s+)?(?:prioritize|prioritise|focus(?:\s+on)?|emphasize|emphasise|highlight)\s+/i,
  ];
  let changed = true;
  while (value && changed) {
    changed = false;
    for (const pattern of leadInPatterns) {
      if (pattern.test(value)) {
        value = value.replace(pattern, "").trim();
        changed = true;
      }
    }
  }
  return value;
}

function extractIntentQueryClause(text: string): string {
  let clause = stripTranscriptLeadInPhrases(text);
  const intentMatch = clause.match(transcriptSearchIntentPattern);
  if (intentMatch && intentMatch.index !== undefined) {
    const afterIntent = clause
      .slice(intentMatch.index + intentMatch[0].length)
      .trim();
    if (afterIntent) {
      clause = afterIntent;
    }
  }
  clause = clause
    .replace(trailingTopicReplacementPattern, "")
    .replace(/\b(?:for|in|on)\s+(?:this|that)\s+(?:new\s+)?(?:search|topic)\b/gi, "")
    .replace(/\b(?:in|for|on)\s+(?:the\s+)?(?:first|next|new)\s+batch\b/gi, "")
    .trim()
    .replace(/\s+/g, " ");
  return clause;
}

function tokenizeQueryTerms(text: string): string[] {
  if (!text.trim()) return [];
  const rawTokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^[-']+|[-']+$/g, ""))
    .filter(Boolean);

  const uniqueTokens: string[] = [];
  for (const token of rawTokens) {
    if (token.length <= 1 && !/\d/.test(token)) continue;
    if (lowerStopWords.has(token)) continue;
    if (lowSignalWords.has(token)) continue;
    if (queryNoiseWords.has(token)) continue;
    if (!uniqueTokens.includes(token)) {
      uniqueTokens.push(token);
    }
  }
  return uniqueTokens;
}

function buildSearchQueryFromTranscript(text: string): string {
  const candidates = splitTranscriptIntoQueryCandidates(text);
  let bestQuery = "";
  let bestScore = -1;

  candidates.forEach((candidate, index) => {
    const extractedClause = extractIntentQueryClause(candidate);
    if (!extractedClause) return;
    const queryTokens = tokenizeQueryTerms(extractedClause);
    if (queryTokens.length === 0) return;

    const candidateText = queryTokens.join(" ");
    const informativeTokenCount = extractInformativeTokens(candidateText).size;
    const anchorTokenCount = extractTopicAnchorTokens(candidateText).size;
    const hasIntent = transcriptSearchIntentPattern.test(candidate);
    const hasShiftCue = explicitTopicShiftPattern.test(candidate);
    const recencyScore = index === candidates.length - 1 ? 2 : 0;
    const score =
      anchorTokenCount * 6 +
      informativeTokenCount * 3 +
      queryTokens.length +
      (hasIntent ? 3 : 0) +
      (hasShiftCue ? 4 : 0) +
      recencyScore;

    if (score >= bestScore) {
      bestScore = score;
      bestQuery = queryTokens.slice(0, 12).join(" ");
    }
  });

  if (bestQuery) return bestQuery;

  const fallbackTokens = tokenizeQueryTerms(text);
  return fallbackTokens.slice(0, 12).join(" ");
}

function mergeTokenSets(base: Set<string>, additions: Set<string>): Set<string> {
  const merged = new Set<string>(base);
  additions.forEach((token) => {
    merged.add(token);
  });
  return merged;
}

function computeSetOverlapRatio(current: Set<string>, reference: Set<string>) {
  if (current.size === 0 || reference.size === 0) {
    return null;
  }
  const shared = countSharedSetItems(current, reference);
  return shared / current.size;
}

function computeTopicCheckReadiness(newTranscriptPayload: string): TopicCheckReadiness {
  const trimmed = newTranscriptPayload.trim();
  const newTranscriptWordCount = countWords(trimmed);
  const newTranscriptCharCount = trimmed.length;
  const sentenceBoundaryCount = countSentenceBoundaries(trimmed);
  const nonEmptyLineCount = countNonEmptyLines(trimmed);
  const informativeTokenCount = extractInformativeTokens(trimmed).size;
  const anchorTokenCount = extractTopicAnchorTokens(trimmed).size;
  const hasTopicShiftCue = explicitTopicShiftPattern.test(trimmed);

  const hasRichContext =
    newTranscriptWordCount >= MIN_TOPIC_CHECK_CONTEXT_WORDS &&
    newTranscriptCharCount >= MIN_TOPIC_CHECK_CONTEXT_CHARS &&
    informativeTokenCount >= MIN_TOPIC_CHECK_CONTEXT_INFO_TOKENS;
  const hasMultiLineContext =
    nonEmptyLineCount >= MIN_TOPIC_CHECK_CONTEXT_LINES &&
    newTranscriptWordCount >= MIN_TOPIC_CHECK_CONTEXT_SENTENCE_WORDS &&
    informativeTokenCount >= 2;
  const hasSentenceContext =
    sentenceBoundaryCount >= 1 &&
    newTranscriptWordCount >= MIN_TOPIC_CHECK_CONTEXT_SENTENCE_WORDS &&
    informativeTokenCount >= 2;
  const hasCueContext =
    hasTopicShiftCue &&
    newTranscriptWordCount >= MIN_TOPIC_CHECK_SHIFT_CUE_WORDS &&
    anchorTokenCount > 0;

  return {
    hasEnoughContext:
      hasRichContext || hasMultiLineContext || hasSentenceContext || hasCueContext,
    newTranscriptWordCount,
    newTranscriptCharCount,
    sentenceBoundaryCount,
    nonEmptyLineCount,
    informativeTokenCount,
    anchorTokenCount,
    hasTopicShiftCue,
  };
}

function computeTopicShiftDecision(params: {
  newTranscriptPayload: string;
  newInfoTokens: Set<string>;
  newAnchorTokens: Set<string>;
  previousInfoTokens: Set<string>;
  activeTopicQuery?: string | null;
}): TopicShiftDecision {
  const {
    newTranscriptPayload,
    newInfoTokens,
    newAnchorTokens,
    previousInfoTokens,
    activeTopicQuery,
  } = params;
  const newTopicTokenCount = countNewSetItems(newInfoTokens, previousInfoTokens);
  const newAnchorTopicTokenCount = countNewSetItems(
    newAnchorTokens,
    previousInfoTokens
  );
  const sharedTopicTokenCount = countSharedSetItems(
    newInfoTokens,
    previousInfoTokens
  );
  const topicTokenTotal = newTopicTokenCount + sharedTopicTokenCount;
  const topicNoveltyRatio =
    topicTokenTotal > 0 ? newTopicTokenCount / topicTokenTotal : 0;

  const hasTopicShiftByNovelty =
    newTopicTokenCount >= MIN_NEW_TOPIC_TOKENS_FOR_LLM_REFRESH &&
    topicNoveltyRatio >= MIN_TOPIC_NOVELTY_RATIO_FOR_LLM_REFRESH;
  const hasTopicShiftByStrongNovelty =
    newTopicTokenCount >= MIN_NEW_TOPIC_TOKENS_FOR_STRONG_SHIFT &&
    topicNoveltyRatio >= MIN_TOPIC_NOVELTY_RATIO_FOR_STRONG_SHIFT &&
    newAnchorTopicTokenCount > 0;
  const hasTopicShiftByAnchorIntent =
    topicShiftIntentPattern.test(newTranscriptPayload) &&
    newAnchorTopicTokenCount > 0;
  const hasTopicShiftByExplicitCue =
    explicitTopicShiftPattern.test(newTranscriptPayload) &&
    newAnchorTokens.size > 0;

  const activeTopicTokens = activeTopicQuery
    ? extractTopicAnchorTokens(activeTopicQuery)
    : new Set<string>();
  const activeTopicOverlapRatio = computeSetOverlapRatio(
    newAnchorTokens,
    activeTopicTokens
  );
  const hasTopicShiftByActiveTopicDivergence =
    activeTopicOverlapRatio !== null &&
    activeTopicOverlapRatio <= 0.34 &&
    newAnchorTopicTokenCount > 0 &&
    (hasTopicShiftByExplicitCue ||
      newTopicTokenCount >= MIN_NEW_TOPIC_TOKENS_FOR_LLM_REFRESH);

  const hasTopicShift =
    hasTopicShiftByExplicitCue ||
    hasTopicShiftByAnchorIntent ||
    hasTopicShiftByNovelty ||
    hasTopicShiftByStrongNovelty ||
    hasTopicShiftByActiveTopicDivergence;

  const topicShiftScore =
    (hasTopicShiftByExplicitCue ? 2 : 0) +
    (hasTopicShiftByAnchorIntent ? 2 : 0) +
    (hasTopicShiftByStrongNovelty ? 2 : 0) +
    (hasTopicShiftByNovelty ? 1 : 0) +
    (hasTopicShiftByActiveTopicDivergence ? 1 : 0) +
    (topicNoveltyRatio >= 0.5 ? 1 : 0) +
    (newAnchorTopicTokenCount >= 2 ? 1 : 0);

  return {
    hasTopicShift,
    newTopicTokenCount,
    newAnchorTopicTokenCount,
    sharedTopicTokenCount,
    topicNoveltyRatio,
    hasTopicShiftByNovelty,
    hasTopicShiftByStrongNovelty,
    hasTopicShiftByAnchorIntent,
    hasTopicShiftByExplicitCue,
    hasTopicShiftByActiveTopicDivergence,
    activeTopicOverlapRatio,
    topicShiftScore,
  };
}

function clampTopicShiftSensitivity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TOPIC_SHIFT_SENSITIVITY;
  return Math.min(5, Math.max(1, Math.round(value)));
}

function getTopicShiftScoreThreshold(sensitivity: number): number {
  const thresholds = [0, 2, 3, 4, 5, 6];
  const index = clampTopicShiftSensitivity(sensitivity);
  return thresholds[index] ?? thresholds[DEFAULT_TOPIC_SHIFT_SENSITIVITY];
}

function buildSearchUrl(type: SuggestionType, query: string): string {
  const encoded = encodeURIComponent(query);
  if (type === "Image") {
    return `https://www.google.com/search?q=${encoded}&tbm=isch`;
  }
  if (type === "Video") {
    return `https://www.youtube.com/results?search_query=${encoded}`;
  }
  if (type === "News") {
    return `https://www.google.com/search?q=${encoded}&tbm=nws`;
  }
  return `https://www.google.com/search?q=${encoded}`;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** Extract the first URL-like substring from free text (e.g. a direct command). */
function extractUrlFromText(text: string): string | null {
  const m = text.match(
    /\b((?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s,)]*)?)/i
  );
  if (!m) return null;
  const raw = m[1];
  return normalizeUrl(raw.startsWith("http") ? raw : `https://${raw}`);
}

function normalizeUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function formatWhisperModelTag(modelPath: string | null | undefined): string {
  const rawPath = (modelPath ?? "").trim();
  if (!rawPath) return "Model: unknown";
  const fileName = rawPath.split(/[\\/]/).pop() ?? rawPath;
  const withoutBin = fileName.replace(/\.bin$/i, "");
  const matched = withoutBin.match(/^ggml-(.+)$/i);
  const modelName = matched?.[1]?.trim() || withoutBin.trim();
  return modelName ? `Model: ${modelName}` : "Model: unknown";
}

type PreferredUrlEntry = {
  url: string;
  description?: string;
};

function parsePreferredUrlEntries(raw: string | undefined | null): PreferredUrlEntry[] {
  if (!raw) return [];
  const normalized = raw
    .split(/\r?\n/)
    .map((line): PreferredUrlEntry | null => {
      const [urlPart, ...descriptionParts] = line.split("|");
      const url = normalizeUrl(urlPart);
      if (!url) return null;
      const description = descriptionParts.join("|").trim();
      const entry: PreferredUrlEntry = { url };
      if (description) {
        entry.description = description;
      }
      return entry;
    })
    .filter((value): value is PreferredUrlEntry => value !== null);
  const uniqueUrls = new Set<string>();
  return normalized.filter((entry) => {
    if (uniqueUrls.has(entry.url)) return false;
    uniqueUrls.add(entry.url);
    return true;
  });
}

function normalizeNameToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

function computeEditDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j < cols; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = matrix[i - 1][j] + 1;
      const insertion = matrix[i][j - 1] + 1;
      const substitution = matrix[i - 1][j - 1] + substitutionCost;
      matrix[i][j] = Math.min(deletion, insertion, substitution);
    }
  }

  return matrix[rows - 1][cols - 1];
}

function isLikelyJamieName(value: string): boolean {
  const normalized = normalizeNameToken(value);
  if (normalized.length < 3) return false;
  if (jamieNameVariants.has(normalized)) return true;
  if (!normalized.startsWith("j")) return false;
  const jamieDistance = computeEditDistance(normalized, "jamie");
  const jaimeDistance = computeEditDistance(normalized, "jaime");
  return Math.min(jamieDistance, jaimeDistance) <= 2;
}

function extractHeyJamieCommandFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const stripped = trimmed.replace(/^\d+\.\s*/, "");
  if (!heyWakeWordPattern.test(stripped)) return null;
  const wakeMatch = stripped.match(heyNameAndCommandPattern);
  if (!wakeMatch) return null;

  const wakeName = wakeMatch[1] ?? "";
  if (!isLikelyJamieName(wakeName)) return null;

  const command = (wakeMatch[2] ?? "")
    .replace(/^[\s,:-]+/, "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ");
  if (!command) return null;
  // Ignore punctuation-only remnants (e.g. "Hey, Jamie." → ".")
  if (/^[^a-zA-Z0-9]*$/.test(command)) return null;
  return command;
}

function extractLatestHeyJamieCommand(lines: string[]): HeyJamieCommand | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const transcriptLine = lines[index]?.trim() ?? "";
    if (!transcriptLine) continue;
    const command = extractHeyJamieCommandFromLine(transcriptLine);
    if (!command) continue;
    return {
      command,
      transcriptLine,
      transcriptLineIndex: index,
    };
  }
  return null;
}

/** Check if two direct commands are semantically similar (user repeating themselves). */
function areDirectCommandsSimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  const tokensA = extractInformativeTokens(a);
  const tokensB = extractInformativeTokens(b);
  if (tokensA.size === 0 && tokensB.size === 0) {
    // Both too short for informative tokens — fall back to normalized comparison
    const na = a.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const nb = b.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    return na === nb;
  }
  const union = new Set([...tokensA, ...tokensB]);
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection += 1;
  }
  // Jaccard similarity ≥ 0.6 means the commands are essentially the same
  return union.size > 0 && intersection / union.size >= 0.6;
}

function buildFallbackSuggestionFromDirectCommand(command: string): Suggestion {
  const normalized = command.toLowerCase();
  const mentionsVisualSubject = /\b(cat|cats|dog|dogs|puppy|puppies|kitten|kittens|bird|birds|parrot|parrots)\b/.test(
    normalized
  );
  const prefersNonImage = directCommandNonImagePattern.test(normalized);
  const selectionStyleCommand =
    directCommandSelectionPattern.test(normalized) && !prefersNonImage;
  const wantsImages =
    directCommandImageIntentPattern.test(normalized) ||
    (selectionStyleCommand && mentionsVisualSubject);
  const mentionsCats = /\b(cat|cats|kitten|kittens)\b/.test(normalized);
  const mentionsDogs = /\b(dog|dogs|puppy|puppies)\b/.test(normalized);
  const type: SuggestionType = wantsImages ? "Image" : "Search";
  const query =
    wantsImages && mentionsCats
      ? "cute cat pictures"
      : wantsImages && mentionsDogs
        ? "cute dog pictures"
        : command;

  return {
    id: crypto.randomUUID(),
    type,
    query,
    note: 'Derived from direct "Hey Jamie" command.',
    rating: 5,
  };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function linkifyText(text: string) {
  const linkRegex =
    /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s)]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const parts: string[] = [];

  while ((match = linkRegex.exec(text)) !== null) {
    const start = match.index;
    if (start > lastIndex) {
      parts.push(escapeHtml(text.slice(lastIndex, start)));
    }
    if (match[2] && match[3]) {
      const safeUrl = escapeHtml(match[3]);
      const safeLabel = escapeHtml(match[2]);
      parts.push(
        `<a href="${safeUrl}" target="_blank" rel="noreferrer">${safeLabel}</a>`
      );
    } else {
      const safeUrl = escapeHtml(match[0]);
      parts.push(
        `<a href="${safeUrl}" target="_blank" rel="noreferrer">${safeUrl}</a>`
      );
    }
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(escapeHtml(text.slice(lastIndex)));
  }

  return parts.join("").replace(/\n/g, "<br />");
}

function extractJsonPayload(text: string): any | null {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;

  if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
    const objStart = candidate.indexOf("{");
    const arrStart = candidate.indexOf("[");
    const startCandidates = [objStart, arrStart].filter((idx) => idx >= 0);
    if (startCandidates.length === 0) return null;
    const start = Math.min(...startCandidates);
    const end =
      start === objStart
        ? candidate.lastIndexOf("}")
        : candidate.lastIndexOf("]");
    if (end <= start) return null;
    candidate = candidate.slice(start, end + 1);
  }

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function normalizeSuggestionType(value: string): SuggestionType | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "search") return "Search";
  if (normalized === "image") return "Image";
  if (normalized === "video") return "Video";
  if (normalized === "news") return "News";
  return null;
}

const EXCALIDRAW_KEYWORDS = [
  "diagram",
  "flowchart",
  "architecture",
  "data flow",
  "schema",
  "entity relationship",
  "org chart",
  "process flow",
  "network topology",
  "system design",
  "microservice",
];

function hasExcalidrawKeywords(text: string): boolean {
  const lower = text.toLowerCase();
  return EXCALIDRAW_KEYWORDS.some((kw) => lower.includes(kw));
}

function buildDefaultBrowserOSPrompts(params: {
  query: string;
  directCommand?: string;
}) {
  const directCommand = params.directCommand?.trim() ?? "";
  const htmlPreference =
    "When choosing between PDF and HTML versions of a document, always prefer the HTML link over the PDF.";
  const snapshotGuidance =
    "Use take_snapshot to observe the current page — it returns an accessibility tree with uid identifiers. " +
    "Use click with the uid parameter to interact with elements. " +
    "Use evaluate_script to search the DOM on large pages when content is not visible in the snapshot.";

  if (directCommand) {
    return {
      browserosSystemPrompt:
        "You are HeyJamie's web automation copilot. " +
        "The user is directly addressing you with a live browser command. " +
        "The wake name may be transcribed with minor spelling variation, but this is still a direct command. " +
        "Execute that command safely and precisely using Chrome DevTools MCP tools. " +
        htmlPreference,
      browserosPrompt:
        `Execute this direct user command on the current browsing session: "${directCommand}". ` +
        "Do not treat the wake name spelling as a constraint; it may vary in transcription. " +
        "If the command references result order (for example first image), use the first visible matching result, perform the click/expand interaction, and then summarize the final state. " +
        htmlPreference + " " +
        snapshotGuidance,
    };
  }

  return {
    browserosSystemPrompt:
      "You are HeyJamie's web automation copilot. " +
      "Act directly through Chrome DevTools MCP tools, continue from the loaded page, and complete the research task safely. " +
      htmlPreference,
    browserosPrompt:
      `Search for "${params.query}" from the currently loaded search page. ` +
      "You MUST click through to the most relevant search result — do not stop on the search results page. " +
      "After reaching the destination page, explore it and return a concise summary of what you found along with the final URL. " +
      htmlPreference + " " +
      snapshotGuidance,
  };
}

function hasInventedPlannerPromptConstraints(
  browserosPrompt: string,
  transcriptPayload: string
): boolean {
  const prompt = browserosPrompt.trim().toLowerCase();
  if (!prompt) return false;
  const transcript = transcriptPayload.toLowerCase();

  const asksForScreenshot = /\bscreenshot(?:s)?\b/.test(prompt);
  const transcriptRequestsScreenshot = /\bscreenshot(?:s)?\b/.test(transcript);
  if (asksForScreenshot && !transcriptRequestsScreenshot) {
    return true;
  }

  const promptHasFixedCountConstraint =
    /\b(?:at\s+least|minimum\s+of|top)\s+\d+\b/.test(prompt) ||
    /\b(?:select|choose|pick|open)\s+\d+\b/.test(prompt);
  const transcriptHasFixedCountConstraint =
    /\b(?:at\s+least|minimum\s+of|top)\s+\d+\b/.test(transcript) ||
    /\b(?:select|choose|pick|open)\s+\d+\b/.test(transcript);
  if (promptHasFixedCountConstraint && !transcriptHasFixedCountConstraint) {
    return true;
  }

  return false;
}

function extractRecentTranscriptLines(
  transcriptPayload: string,
  maxLines: number
): string {
  if (!transcriptPayload.trim()) return "";
  return transcriptPayload
    .split("\n")
    .slice(-maxLines)
    .join("\n")
    .trim();
}

function buildTranscriptWithSeparator(
  transcriptPayload: string,
  recentLineCount: number
): string {
  if (!transcriptPayload.trim()) return "";
  const lines = transcriptPayload.split("\n");
  if (lines.length <= recentLineCount) {
    // All lines are "recent" - no separator needed
    return transcriptPayload;
  }
  const olderLines = lines.slice(0, -recentLineCount);
  const recentLines = lines.slice(-recentLineCount);
  return [
    ...olderLines,
    "",
    "*** Most recent messages below ***",
    "",
    ...recentLines,
  ].join("\n").trim();
}

function loadSidebarCollapsed() {
  try {
    return localStorage.getItem("heyjamie.sidebarCollapsed") === "true";
  } catch {
    return false;
  }
}

function readMockTranscriptSelection(): string {
  const envSelection = (
    import.meta.env.VITE_HEYJAMIE_MOCK_TRANSCRIPT ?? ""
  ).trim();
  try {
    const querySelection =
      new URLSearchParams(window.location.search).get("mockTranscript")?.trim() ??
      "";
    return querySelection || envSelection;
  } catch {
    return envSelection;
  }
}

/** Await a promise with a timeout. Resolves (best-effort) even if the promise
 *  never settles, preventing cancel flows from hanging indefinitely. */
async function awaitWithTimeout<T>(promise: Promise<T> | null, ms: number): Promise<void> {
  if (!promise) return;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("cancel timeout")), ms),
      ),
    ]);
  } catch {
    /* best-effort — swallow both the timeout and any promise rejection */
  }
}

export function App() {
  const availableMockTranscriptIds = React.useMemo(
    () => listMockTranscriptIds(),
    []
  );
  const mockTranscriptSelection = React.useMemo(
    () => readMockTranscriptSelection(),
    []
  );
  const mockTranscript = React.useMemo(
    () => getMockTranscript(mockTranscriptSelection),
    [mockTranscriptSelection]
  );
  const mockTranscriptMode = Boolean(mockTranscript);
  const testLogEnabled = React.useMemo(
    () =>
      mockTranscriptMode &&
      isTruthyFlag(import.meta.env.VITE_HEYJAMIE_ENABLE_TEST_LOG),
    [mockTranscriptMode]
  );

  const [transcripts, setTranscripts] = React.useState<TranscriptEntry[]>([]);
  const [interimText, setInterimText] = React.useState("");
  const [activeTopic, setActiveTopic] = React.useState<Suggestion | null>(null);
  const [suggestionsNarrative, setSuggestionsNarrative] = React.useState("");
  const [suggestionsLog, setSuggestionsLog] = React.useState<SuggestionLogEntry[]>(
    []
  );
  const [chapters, setChapters] = React.useState<ChapterEntry[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = React.useState({
    isLoading: false,
    message: "Running browser deep dive...",
  });
  const [status, setStatus] = React.useState<StatusState>({
    text: "Not listening",
    meta: "Ready when you are.",
    live: false,
  });
  const [whisperReady, setWhisperReady] = React.useState(false);
  const [setupStatus, setSetupStatus] = React.useState(
    "This can take a few minutes and will download the base model."
  );
  const [showSetupCard, setShowSetupCard] = React.useState(false);
  const [_excalidrawReady, setExcalidrawReady] = React.useState(false);
  const [excalidrawSetupStatus, setExcalidrawSetupStatus] = React.useState(
    "This will clone and build mcp_excalidraw locally."
  );
  const [showExcalidrawSetupCard, setShowExcalidrawSetupCard] = React.useState(false);
  const [isListening, setIsListening] = React.useState(false);
  const [speechTag, setSpeechTag] = React.useState("Transcription: unavailable");
  const [speechModelTag, setSpeechModelTag] = React.useState("Model: unknown");
  const [llmTag, setLlmTag] = React.useState("LLM: not configured");
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(
    loadSidebarCollapsed()
  );
  const [sessionStartMs, setSessionStartMs] = React.useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = React.useState(0);
  const [devPlaybackState, setDevPlaybackState] = React.useState<
    "idle" | "playing" | "paused"
  >("idle");
  const [devPlaybackProgress, setDevPlaybackProgress] = React.useState({
    current: 0,
    total: 0,
  });
  const [devModeEnabled, setDevModeEnabled] = React.useState(false);
  const [devTranscriptAvailable, setDevTranscriptAvailable] = React.useState(false);
  const [devTranscriptName, setDevTranscriptName] = React.useState("");
  const [quickTopicShiftSensitivity, setQuickTopicShiftSensitivity] = React.useState(
    DEFAULT_TOPIC_SHIFT_SENSITIVITY
  );
  const [quickEvaluationDelayMs, setQuickEvaluationDelayMs] = React.useState(
    DEFAULT_EVALUATION_DELAY_MS
  );
  const [quickPersona, setQuickPersona] = React.useState(NO_PERSONA_ID);
  const [_quickMcpConfigRaw, setQuickMcpConfigRaw] = React.useState("");
  const [_quickMcpConfig, setQuickMcpConfig] = React.useState<Record<string, unknown> | null>(
    null
  );
  const [quickMcpServers, setQuickMcpServers] = React.useState<McpServerSummary[]>([]);
  const [quickMcpLoading, setQuickMcpLoading] = React.useState(false);
  const [_quickMcpStatus, setQuickMcpStatus] = React.useState("");
  const [quickMcpError, setQuickMcpError] = React.useState("");

  const meterRef = React.useRef<HTMLSpanElement | null>(null);
  const isListeningRef = React.useRef(false);
  const transcriptsRef = React.useRef(transcripts);
  const transcriptScrollRef = React.useRef<HTMLDivElement | null>(null);
  const narrativeScrollRef = React.useRef<HTMLDivElement | null>(null);
  const chaptersRef = React.useRef(chapters);
  const sessionStartMsRef = React.useRef<number | null>(null);
  const suggestionsNarrativeRef = React.useRef(suggestionsNarrative);
  const browserosDeepDiveTimerRef = React.useRef<number | null>(null);
  const lastSuggestionTranscriptRef = React.useRef("");
  const lastSuggestionTranscriptLineCountRef = React.useRef(0);
  const lastSuggestionInfoTokensRef = React.useRef<Set<string>>(new Set<string>());
  const lastSuggestionNumericTokensRef = React.useRef<Set<string>>(
    new Set<string>()
  );
  const hasTriggeredDeepDiveRef = React.useRef(false);
  const activeTaskTypeRef = React.useRef<"browser" | "excalidraw" | null>(null);
  const browserWindowOpenedRef = React.useRef(false);
  const browserosInFlightRef = React.useRef(false);
  const browserosRunStartedAtRef = React.useRef(0);
  const lastIntentPlanCacheRef = React.useRef<{
    plan: BrowserOSIntentPlan;
    query: string;
    infoTokens: Set<string>;
    actionType: "browser" | "excalidraw";
    timestamp: number;
  } | null>(null);
  const browserosRunPromiseRef = React.useRef<Promise<void> | null>(null);
  const browserosRunCancelledRef = React.useRef(false);
  const browserosRunCountRef = React.useRef(0);
  const lastBrowserOSTaskRef = React.useRef("");
  const lastBrowserOSPageUrlRef = React.useRef("");
  const lastHeyJamieCommandKeyRef = React.useRef("");
  const inFlightDirectCommandRef = React.useRef("");
  const pendingBrowserOSReplayRef = React.useRef(false);
  const lastDeepDiveCompletedAtRef = React.useRef(0);
  const runBrowserOSDeepDiveRef = React.useRef<() => void>(() => {});
  const mockPlaybackTimersRef = React.useRef<number[]>([]);
  const mockPlaybackStartTimerRef = React.useRef<number | null>(null);
  const hasPlayedMockTranscriptRef = React.useRef(false);
  const mockPlaybackCompletedRef = React.useRef(false);
  const mockPlaybackActiveRef = React.useRef(false);
  const lastMockTranscriptIdRef = React.useRef<string | null>(null);
  const handleTranscriptChunkRef = React.useRef<(text: string) => void>(() => {});
  const testLogWriteChainRef = React.useRef<Promise<void>>(Promise.resolve());
  const integrationRunFinalizedRef = React.useRef(false);
  const browserosRunsStartedRef = React.useRef(0);
  const browserosRunsSucceededRef = React.useRef(0);
  const browserosRunsFailedRef = React.useRef(0);
  const browserosRunsPendingRef = React.useRef(0);
  const excalidrawCanvasPreloadedRef = React.useRef(false);
  const excalidrawRunsStartedRef = React.useRef(0);
  const excalidrawRunsSucceededRef = React.useRef(0);
  const excalidrawRunsFailedRef = React.useRef(0);
  const excalidrawRunsPendingRef = React.useRef(0);
  const lastChapterTranscriptRef = React.useRef("");
  const lastChapterTranscriptLineCountRef = React.useRef(0);
  const lastChapterInfoTokensRef = React.useRef<Set<string>>(new Set<string>());
  const lastChapterNumericTokensRef = React.useRef<Set<string>>(new Set<string>());
  const devPlaybackTimersRef = React.useRef<number[]>([]);
  const devPlaybackLinesRef = React.useRef<string[]>([]);
  const devPlaybackNextLineRef = React.useRef(0);
  const devPlaybackDelayMsRef = React.useRef(550);
  const audioStreamRef = React.useRef<MediaStream | null>(null);
  const audioContextRef = React.useRef<AudioContext | null>(null);
  const analyserRef = React.useRef<AnalyserNode | null>(null);
  const processorRef = React.useRef<ScriptProcessorNode | null>(null);
  const silenceNodeRef = React.useRef<GainNode | null>(null);
  const meterFrameRef = React.useRef<number | null>(null);
  const bufferChunksRef = React.useRef<Float32Array[]>([]);
  const bufferLengthRef = React.useRef(0);
  const pendingQueueRef = React.useRef<Uint8Array[]>([]);
  const isTranscribingRef = React.useRef(false);
  const hadTranscriptionErrorRef = React.useRef(false);
  const skippedQuietSegmentsRef = React.useRef(0);

  React.useEffect(() => {
    transcriptsRef.current = transcripts;
  }, [transcripts]);

  React.useEffect(() => {
    chaptersRef.current = chapters;
  }, [chapters]);

  React.useEffect(() => {
    sessionStartMsRef.current = sessionStartMs;
    if (sessionStartMs === null) {
      setElapsedMs(0);
      return;
    }
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - sessionStartMs);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [sessionStartMs]);

  React.useEffect(() => {
    suggestionsNarrativeRef.current = suggestionsNarrative;
  }, [suggestionsNarrative]);

  React.useEffect(() => {
    isListeningRef.current = isListening;
  }, [isListening]);

  React.useEffect(() => {
    try {
      localStorage.setItem("heyjamie.sidebarCollapsed", String(sidebarCollapsed));
    } catch {
      // ignore storage errors
    }
  }, [sidebarCollapsed]);

  const log = React.useCallback((...args: unknown[]) => {
    console.log(LOG_PREFIX, ...args);
  }, []);

  const logFrontend = React.useCallback(async (message: string) => {
    try {
      await invoke("log_frontend", { message });
    } catch (error) {
      console.warn(LOG_PREFIX, "Failed to forward log to backend.", error);
    }
  }, []);

  const logLlm = React.useCallback(
    (message: string, payload?: unknown) => {
      log(message, payload);
      let serialized = "";
      if (payload !== undefined) {
        try {
          serialized = JSON.stringify(payload);
        } catch {
          serialized = String(payload);
        }
      }
      const full = serialized ? `${message} ${serialized}` : message;
      void logFrontend(truncateText(full, 2000));
    },
    [log, logFrontend]
  );

  const recordChapter = React.useCallback(
    (params: {
      title: string;
      timestamp: number;
      transcriptIndex: number;
      source: ChapterSource;
    }): string | null => {
      const sessionStart = sessionStartMsRef.current ?? params.timestamp;
      if (!sessionStartMsRef.current) {
        sessionStartMsRef.current = sessionStart;
        setSessionStartMs(sessionStart);
      }
      const timestampMs = Math.max(0, params.timestamp - sessionStart);
      const chapterId = crypto.randomUUID();
      let added = false;
      setChapters((prev) => {
        const last = prev[prev.length - 1];
        if (last) {
          if (
            last.title.toLowerCase() === params.title.toLowerCase() &&
            timestampMs - last.timestampMs < MIN_CHAPTER_GAP_MS
          ) {
            return prev;
          }
          if (timestampMs - last.timestampMs < MIN_CHAPTER_GAP_MS) {
            return prev;
          }
        }
        added = true;
        const entry: ChapterEntry = {
          id: chapterId,
          title: params.title,
          timestampMs,
          transcriptIndex: params.transcriptIndex,
          source: params.source,
          urls: [],
        };
        const next = [...prev, entry];
        chaptersRef.current = next;
        return next;
      });
      return added ? chapterId : null;
    },
    []
  );

  const refineChapterTitle = React.useCallback(
    (chapterId: string, transcriptContext: string, fallbackTitle: string) => {
      const settings = loadOpenRouterSettings();
      if (!hasOpenRouterKey(settings)) return;

      generateChapterTitleViaLLM(
        transcriptContext,
        fallbackTitle,
        settings.apiKey,
        settings.model
      ).then((betterTitle) => {
        if (betterTitle === fallbackTitle) return;
        setChapters((prev) => {
          const idx = prev.findIndex((c) => c.id === chapterId);
          if (idx === -1) return prev;
          const updated = [...prev];
          updated[idx] = { ...updated[idx], title: betterTitle };
          chaptersRef.current = updated;
          return updated;
        });
      });
    },
    []
  );

  const addUrlToCurrentChapter = React.useCallback((url: string) => {
    if (!url || !isHttpUrl(url)) return;
    setChapters((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.urls.includes(url)) return prev;
      const updated = [...prev];
      updated[updated.length - 1] = { ...last, urls: [...last.urls, url] };
      chaptersRef.current = updated;
      return updated;
    });
  }, []);

  const ensureSessionStart = React.useCallback((timestamp: number) => {
    if (sessionStartMsRef.current) return;
    sessionStartMsRef.current = timestamp;
    setSessionStartMs(timestamp);
  }, []);

  const updateChaptersFromTranscript = React.useCallback(() => {
    const transcriptEntries = transcriptsRef.current;
    if (transcriptEntries.length === 0) return;
    const transcriptLines = getTranscriptTexts(transcriptEntries);
    const transcriptPayload = transcriptLines.join("\n");
    if (transcriptPayload === lastChapterTranscriptRef.current) return;

    const newTranscriptLines = transcriptLines.slice(
      lastChapterTranscriptLineCountRef.current
    );
    if (newTranscriptLines.length === 0) {
      lastChapterTranscriptRef.current = transcriptPayload;
      return;
    }

    const newTranscriptPayload = newTranscriptLines.join("\n");
    const topicCheckReadiness = computeTopicCheckReadiness(newTranscriptPayload);
    if (!topicCheckReadiness.hasEnoughContext) {
      lastChapterTranscriptRef.current = transcriptPayload;
      lastChapterTranscriptLineCountRef.current = transcriptLines.length;
      lastChapterInfoTokensRef.current = mergeTokenSets(
        lastChapterInfoTokensRef.current,
        extractInformativeTokens(newTranscriptPayload)
      );
      lastChapterNumericTokensRef.current = mergeTokenSets(
        lastChapterNumericTokensRef.current,
        extractNumericTokens(newTranscriptPayload)
      );
      return;
    }

    const newInfoTokens = extractInformativeTokens(newTranscriptPayload);
    const newAnchorTokens = extractTopicAnchorTokens(newTranscriptPayload);
    const topicShiftDecision = computeTopicShiftDecision({
      newTranscriptPayload,
      newInfoTokens,
      newAnchorTokens,
      previousInfoTokens: lastChapterInfoTokensRef.current,
      activeTopicQuery: activeTopic?.query ?? null,
    });

    if (!topicShiftDecision.hasTopicShift) {
      lastChapterTranscriptRef.current = transcriptPayload;
      lastChapterTranscriptLineCountRef.current = transcriptLines.length;
      lastChapterInfoTokensRef.current = mergeTokenSets(
        lastChapterInfoTokensRef.current,
        newInfoTokens
      );
      lastChapterNumericTokensRef.current = mergeTokenSets(
        lastChapterNumericTokensRef.current,
        extractNumericTokens(newTranscriptPayload)
      );
      return;
    }

    const lastEntry = transcriptEntries[transcriptEntries.length - 1];
    const title = buildChapterTitleFromTranscript(newTranscriptPayload);
    ensureSessionStart(lastEntry.timestamp);
    const topicShiftChapterId = recordChapter({
      title,
      timestamp: lastEntry.timestamp,
      transcriptIndex: transcriptEntries.length,
      source: "topic-shift",
    });
    if (topicShiftChapterId) {
      refineChapterTitle(topicShiftChapterId, newTranscriptPayload, title);
    }
    lastChapterTranscriptRef.current = transcriptPayload;
    lastChapterTranscriptLineCountRef.current = transcriptLines.length;
    lastChapterInfoTokensRef.current = extractInformativeTokens(transcriptPayload);
    lastChapterNumericTokensRef.current = extractNumericTokens(transcriptPayload);
  }, [activeTopic?.query, ensureSessionStart, recordChapter, refineChapterTitle]);

  const queueTestLogWrite = React.useCallback(
    (writer: () => Promise<void>) => {
      if (!testLogEnabled) return;
      testLogWriteChainRef.current = testLogWriteChainRef.current
        .then(writer)
        .catch((error) => {
          log("Failed to write integration test log.", error);
        });
    },
    [log, testLogEnabled]
  );

  const appendTestLogEvent = React.useCallback(
    (event: Record<string, unknown>) => {
      if (!testLogEnabled) return;
      queueTestLogWrite(async () => {
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          ...event,
        });
        await invoke("append_test_log", { line });
      });
    },
    [queueTestLogWrite, testLogEnabled]
  );

  const resetTestLogForRun = React.useCallback(
    (params: { transcriptId: string; playableLineCount: number; markerCount: number }) => {
      if (!testLogEnabled) return;
      integrationRunFinalizedRef.current = false;
      browserosRunsStartedRef.current = 0;
      browserosRunsSucceededRef.current = 0;
      browserosRunsFailedRef.current = 0;
      browserosRunsPendingRef.current = 0;
      excalidrawCanvasPreloadedRef.current = false;
      excalidrawRunsStartedRef.current = 0;
      excalidrawRunsSucceededRef.current = 0;
      excalidrawRunsFailedRef.current = 0;
      excalidrawRunsPendingRef.current = 0;
      queueTestLogWrite(async () => {
        const path = await invoke<string>("reset_test_log", {
          runLabel: `mock:${params.transcriptId}`,
        });
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          event: "run-start",
          transcriptId: params.transcriptId,
          playableLineCount: params.playableLineCount,
          markerCount: params.markerCount,
          logPath: path,
        });
        await invoke("append_test_log", { line });
      });
    },
    [queueTestLogWrite, testLogEnabled]
  );

  const maybeFinalizeIntegrationTestRun = React.useCallback(() => {
    if (!testLogEnabled) return;
    if (!mockPlaybackCompletedRef.current) return;
    if (integrationRunFinalizedRef.current) return;
    if (browserosRunsPendingRef.current > 0) return;
    if (excalidrawRunsPendingRef.current > 0) return;
    if (browserosInFlightRef.current) return;
    if (pendingBrowserOSReplayRef.current) return;
    if (browserosDeepDiveTimerRef.current !== null) return;
    if (
      lastSuggestionTranscriptLineCountRef.current <
      transcriptsRef.current.length
    ) {
      return;
    }

    integrationRunFinalizedRef.current = true;
    const started = browserosRunsStartedRef.current;
    const succeeded = browserosRunsSucceededRef.current;
    const failed = browserosRunsFailedRef.current;
    const excalidrawStarted = excalidrawRunsStartedRef.current;
    const excalidrawSucceeded = excalidrawRunsSucceededRef.current;
    const excalidrawFailed = excalidrawRunsFailedRef.current;
    const totalStarted = started + excalidrawStarted;
    const totalFailed = failed + excalidrawFailed;
    const status =
      totalStarted === 0 ? "no-browseros-runs" : totalFailed > 0 ? "failed" : "success";
    appendTestLogEvent({
      event: "run-complete",
      status,
      browserosRunsStarted: started,
      browserosRunsSucceeded: succeeded,
      browserosRunsFailed: failed,
      excalidrawRunsStarted: excalidrawStarted,
      excalidrawRunsSucceeded: excalidrawSucceeded,
      excalidrawRunsFailed: excalidrawFailed,
    });
  }, [appendTestLogEvent, testLogEnabled]);

  const setStatusState = React.useCallback(
    (text: string, meta: string, live: boolean) => {
      setStatus({ text, meta, live });
    },
    []
  );

  const updateSpeechTag = React.useCallback((ready: boolean) => {
    if (mockTranscriptMode && mockTranscript) {
      setSpeechTag(`Transcription: mock (${mockTranscript.id})`);
      return;
    }
    setSpeechTag(
      ready ? "Transcription: whisper.cpp" : "Transcription: unavailable"
    );
  }, [mockTranscript, mockTranscriptMode]);

  const updateLlmTag = React.useCallback(() => {
    const settings = loadOpenRouterSettings();
    setLlmTag(
      hasOpenRouterKey(settings)
        ? `LLM: ${settings.model}`
        : "LLM: not configured"
    );
  }, []);

  const stopMockPlayback = React.useCallback(() => {
    mockPlaybackTimersRef.current.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    mockPlaybackTimersRef.current = [];
  }, []);

  const stopDevPlayback = React.useCallback(() => {
    devPlaybackTimersRef.current.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    devPlaybackTimersRef.current = [];
  }, []);

  const startDevPlayback = React.useCallback(
    (fromLine: number) => {
      const rawTranscript = localStorage.getItem("heyjamie.devTranscript");
      if (!rawTranscript) return;

      const allLines = rawTranscript
        .split(/\r?\n/)
        .filter((l) => l.trim());
      devPlaybackLinesRef.current = allLines;

      if (fromLine >= allLines.length) {
        setDevPlaybackState("idle");
        setDevPlaybackProgress({ current: allLines.length, total: allLines.length });
        return;
      }

      setDevPlaybackState("playing");
      setDevPlaybackProgress({ current: fromLine, total: allLines.length });

      const settings = loadOpenRouterSettings();
      const delay = settings.devTranscriptDelayMs;
      devPlaybackDelayMsRef.current = delay;

      let playbackOffsetMs = 0;
      const linesToPlay = allLines.slice(fromLine);
      linesToPlay.forEach((line, idx) => {
        const lineIndex = fromLine + idx;
        const sleepMatch = line.match(mockPlaybackSleepPattern);
        if (sleepMatch) {
          const rawSleepMs = Number.parseInt(sleepMatch[1] ?? "", 10);
          const sleepMs =
            Number.isFinite(rawSleepMs) && rawSleepMs > 0 ? rawSleepMs : 0;
          if (sleepMs > 0) {
            playbackOffsetMs += sleepMs;
          }
          // Schedule a no-op timer to track progress for sleep markers
          const timerId = window.setTimeout(() => {
            devPlaybackNextLineRef.current = lineIndex + 1;
            setDevPlaybackProgress({ current: lineIndex + 1, total: allLines.length });
            if (lineIndex === allLines.length - 1) {
              setDevPlaybackState("idle");
            }
          }, playbackOffsetMs);
          devPlaybackTimersRef.current.push(timerId);
          return;
        }

        const timerId = window.setTimeout(() => {
          handleTranscriptChunkRef.current(line);
          devPlaybackNextLineRef.current = lineIndex + 1;
          setDevPlaybackProgress({ current: lineIndex + 1, total: allLines.length });
          if (lineIndex === allLines.length - 1) {
            setDevPlaybackState("idle");
          }
        }, playbackOffsetMs);
        devPlaybackTimersRef.current.push(timerId);
        playbackOffsetMs += delay;
      });
    },
    []
  );

  const pauseDevPlayback = React.useCallback(() => {
    stopDevPlayback();
    setDevPlaybackState("paused");
  }, [stopDevPlayback]);

  const resumeDevPlayback = React.useCallback(() => {
    startDevPlayback(devPlaybackNextLineRef.current);
  }, [startDevPlayback]);

  const focusChrome = React.useCallback(async () => {
    try {
      await invoke("focus_chrome_window");
    } catch {
      // best effort
    }
  }, []);

  const focusChromeTab = React.useCallback(async (urlPrefix: string) => {
    try {
      await invoke("focus_chrome_tab", { urlPrefix });
    } catch {
      // best effort — tab may not exist yet
    }
  }, []);

  const openBrowserWindow = React.useCallback(async (url: string) => {
    // Always use newTab to avoid creating new windows — persistent Chrome
    // already has a window managed by MCP.
    try {
      await invoke("open_browser_window", { url, newTab: true });
      browserWindowOpenedRef.current = true;
      return true;
    } catch (error) {
      log("Failed to open browser window.", error);
      return false;
    }
  }, [log]);

  const openSuggestionUrl = React.useCallback(
    async (url: string) => {
      const opened = await openBrowserWindow(url);
      if (opened) return true;

      try {
        await openUrl(url);
        return true;
      } catch {
        const fallbackWindow = window.open(url, "_blank");
        return fallbackWindow !== null;
      }
    },
    [openBrowserWindow]
  );

  const openSuggestionInBrowser = React.useCallback(
    async (suggestion: Suggestion) => {
      const url = suggestion.url ?? buildSearchUrl(suggestion.type, suggestion.query);
      if (!url) return;
      await openSuggestionUrl(url);
    },
    [openSuggestionUrl]
  );

  const setSuggestionsLoadingState = React.useCallback(
    (isLoading: boolean, message?: string) => {
      setSuggestionsLoading({
        isLoading,
        message: message ?? "Running browser deep dive...",
      });
    },
    []
  );

  const addSuggestionLogEntry = React.useCallback(
    (entry: {
      narrative: string;
      toolCalls: ToolCallDetail[];
      suggestions: Suggestion[];
    }) => {
      const record: SuggestionLogEntry = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        narrative: entry.narrative.trim(),
        toolCalls: entry.toolCalls,
        suggestions: entry.suggestions,
      };
      setSuggestionsLog((prev) => {
        const next = [record, ...prev];
        return next.slice(0, MAX_SUGGESTION_LOG_ENTRIES);
      });
    },
    []
  );

  /**
   * Use LLM to detect whether the user has shifted to a new topic.
   * Returns null if detection fails or is unavailable.
   */
  const detectTopicShiftWithLLM = React.useCallback(
    async (params: {
      activeTopicQuery: string | null;
      activeTaskType: "browser" | "excalidraw" | null;
      recentTranscript: string;
    }): Promise<{
      hasTopicShift: boolean;
      confidence: number;
      newTopicSummary: string;
      reasoning: string;
      suggestedActionType: "browser" | "excalidraw" | "none" | null;
    } | null> => {
      const settings = loadOpenRouterSettings();
      if (!hasOpenRouterKey(settings)) {
        return null;
      }

      try {
        const content = await invoke<string>("run_llm_agent", {
          payload: {
            mode: "topic-shift-detect",
            settings: {
              apiKey: settings.apiKey,
              model: settings.model,
            },
            activeTopicQuery: params.activeTopicQuery ?? "",
            activeTaskType: params.activeTaskType ?? "",
            recentTranscript: params.recentTranscript,
          },
        });

        const parsed = extractJsonPayload(content);
        if (
          parsed &&
          typeof parsed === "object" &&
          "ok" in parsed &&
          parsed.ok === true
        ) {
          return {
            hasTopicShift: !!parsed.hasTopicShift,
            confidence:
              typeof parsed.confidence === "number" ? parsed.confidence : 0,
            newTopicSummary:
              typeof parsed.newTopicSummary === "string"
                ? parsed.newTopicSummary
                : "",
            reasoning:
              typeof parsed.reasoning === "string" ? parsed.reasoning : "",
            suggestedActionType:
              parsed.suggestedActionType === "browser" ||
              parsed.suggestedActionType === "excalidraw" ||
              parsed.suggestedActionType === "none"
                ? parsed.suggestedActionType
                : null,
          };
        }
        return null;
      } catch (error) {
        logLlm("Topic shift LLM detection failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    [logLlm]
  );

  const resolveBrowserOSIntentPlan = React.useCallback(
    async (params: {
      suggestion: Suggestion;
      transcriptPayload: string;
      narrative: string;
      directCommand: string;
      latestSpeech?: string;
    }): Promise<BrowserOSIntentPlan> => {
      const { suggestion, transcriptPayload, narrative } = params;
      const directCommand = params.directCommand.trim();
      const fallbackPrompts = buildDefaultBrowserOSPrompts({
        query: suggestion.query,
        directCommand,
      });
      const fallbackIsExcalidraw =
        !directCommand && hasExcalidrawKeywords(transcriptPayload);
      const fallbackPlan: BrowserOSIntentPlan = {
        suggestion,
        narrative,
        browserosPrompt: fallbackPrompts.browserosPrompt,
        browserosSystemPrompt: fallbackPrompts.browserosSystemPrompt,
        plannerSource: "fallback",
        plannerReasoning: "",
        actionType: fallbackIsExcalidraw ? "excalidraw" : "browser",
        excalidrawPrompt: fallbackIsExcalidraw ? transcriptPayload : "",
        excalidrawSystemPrompt: fallbackIsExcalidraw
          ? "You are a diagram creation agent. Use the Excalidraw MCP tools to create a clear, well-organized diagram."
          : "",
        userNote: "",
      };

      const settings = loadOpenRouterSettings();
      if (!hasOpenRouterKey(settings)) {
        return fallbackPlan;
      }

      // Cache check: reuse recent intent plan for the same topic to skip LLM call
      if (!directCommand && lastIntentPlanCacheRef.current) {
        const cache = lastIntentPlanCacheRef.current;
        const cacheAgeMs = Date.now() - cache.timestamp;
        if (cacheAgeMs < 60_000) {
          const currentTokens = extractInformativeTokens(transcriptPayload);
          let sharedCount = 0;
          for (const token of currentTokens) {
            if (cache.infoTokens.has(token)) sharedCount++;
          }
          const overlapRatio = cache.infoTokens.size > 0
            ? sharedCount / cache.infoTokens.size
            : 0;
          const currentIsExcalidraw = hasExcalidrawKeywords(transcriptPayload);
          const actionTypeMatch =
            (cache.actionType === "excalidraw") === currentIsExcalidraw ||
            cache.actionType === "browser";
          if (overlapRatio > 0.5 && actionTypeMatch) {
            logLlm("BrowserOS intent planner cache hit — reusing cached plan.", {
              cacheAgeMs,
              overlapRatio: Number(overlapRatio.toFixed(2)),
              cachedQuery: cache.query,
              currentQuery: suggestion.query,
              actionType: cache.actionType,
            });
            return {
              ...cache.plan,
              suggestion: { ...cache.plan.suggestion, ...suggestion },
              narrative,
            };
          }
        }
      }

      const preferredUrlEntries = parsePreferredUrlEntries(settings.preferredUrls);

      const recentTranscript = extractRecentTranscriptLines(
        transcriptPayload,
        BROWSEROS_INTENT_RECENT_LINE_COUNT
      );
      const plannerInstructionLines = [settings.narrativePrompt];
      const userNotesBlock = formatUserNotesForPrompt(loadUserNotes());
      if (userNotesBlock) {
        plannerInstructionLines.push(userNotesBlock);
      }
      if (preferredUrlEntries.length > 0) {
        plannerInstructionLines.push(
          "Preferred URLs are user-curated sources. Each entry includes a url and optional description context.",
          "If one is relevant, set startUrl to that exact URL and prioritize it before fresh searches.",
          "Only use a startUrl from preferredUrls when relevant to the transcript. Otherwise set startUrl to an empty string."
        );
      }
      if (!directCommand) {
        const persona = getPersonaById(settings.persona);
        if (persona) {
          plannerInstructionLines.push("", persona.plannerPrompt);
        }
      }
      plannerInstructionLines.push(
        "",
        "## User Note Detection",
        'If the directCommand is a preference, instruction, or note to remember (e.g. "remember that I prefer...",',
        '"never do X", "always use Y"), include a "userNote" field with the cleaned-up note text. Only set userNote',
        "when the command is clearly a preference/instruction to remember. If not a note, omit or set to empty string.",
        "",
        "## Avoiding Redundant Searches",
        "The context includes lastBrowserOSPageUrl — the URL currently open in the browser.",
        "If lastBrowserOSPageUrl is already a search results page (e.g. google.com/search)",
        "for a query similar to the current topic, do NOT generate a new search. Instead,",
        "set startUrl to lastBrowserOSPageUrl and write a browserosPrompt that clicks the",
        "most relevant link on the existing results page, then explores and summarizes the",
        "destination.",
        "Avoid generating searches that are near-duplicates of existingSuggestion.query. If",
        "the topic hasn't substantially changed, prefer exploring existing results over",
        "re-searching with slight query variations.",
        "",
        "## General",
        "IMPORTANT: If a latestSpeech field is present in the context, it contains ONLY the newest transcript lines since the last evaluation. You MUST base your actionType decision primarily on latestSpeech — it represents what the user is talking about RIGHT NOW. If latestSpeech discusses podcasts, videos, articles, news, or any browsable content, set actionType to 'browser' even if older parts of the transcript discussed diagrams or architecture. The fullTranscript is background context only; the latestSpeech is the current request.",
        "When generating browserosPrompt, always include multi-step instructions. For search tasks, instruct the agent to: (1) search, (2) click the most relevant result, and (3) explore and summarize the destination page. The agent should never stop on a search results page.",
        "Return only strict JSON with this schema:",
        '{"actionType":"browser|excalidraw","query":"string","suggestionType":"Search|Image|Video|News","startUrl":"string","browserosSystemPrompt":"string","browserosPrompt":"string","excalidrawPrompt":"string","excalidrawSystemPrompt":"string","narrative":"string","reasoning":"string","userNote":"string"}',
        "Do not include markdown or extra commentary."
      );
      const plannerInstructions = plannerInstructionLines.join("\n");

      // For direct commands, don't pre-fill existingSuggestion.url with a
      // search URL — that anchors the planner into copying it as
      // startUrl.  Pass it only when the suggestion has a genuine URL.
      const suggestionUrlForPlanner = directCommand
        ? suggestion.url ?? ""
        : suggestion.url ?? buildSearchUrl(suggestion.type, suggestion.query);
      const fullTranscriptWithSeparator = buildTranscriptWithSeparator(
        transcriptPayload,
        BROWSEROS_INTENT_RECENT_LINE_COUNT
      );
      const latestSpeech = params.latestSpeech?.trim() || "";
      const plannerContext = {
        directCommand: directCommand || null,
        lastBrowserOSPageUrl: lastBrowserOSPageUrlRef.current || null,
        preferredUrls: preferredUrlEntries,
        existingSuggestion: {
          query: suggestion.query,
          suggestionType: suggestion.type,
          note: suggestion.note,
          url: suggestionUrlForPlanner,
        },
        existingNarrative: narrative,
        guidance: {
          prioritizeRecentTranscript: true,
          recentTranscriptLineCount: BROWSEROS_INTENT_RECENT_LINE_COUNT,
          fullTranscriptIncluded: true,
        },
        ...(latestSpeech ? { latestSpeech } : {}),
        recentTranscript,
        fullTranscript: fullTranscriptWithSeparator,
      };

      try {
        const content = await invoke<string>("run_llm_agent", {
          payload: {
            mode: "browseros-intent",
            settings: {
              apiKey: settings.apiKey,
              model: settings.model,
              reasoning: settings.reasoning,
            },
            instructions: plannerInstructions,
            prompt: JSON.stringify(plannerContext),
            context: plannerContext,
          },
        });

        let plannerResult: unknown = content;
        try {
          plannerResult = JSON.parse(content);
        } catch {
          const extracted = extractJsonPayload(content);
          if (extracted) {
            plannerResult = extracted;
          }
        }

        const plannerPayload =
          plannerResult && typeof plannerResult === "object"
            ? (plannerResult as BrowserOSIntentPlannerResponse)
            : null;
        if (!plannerPayload) {
          logLlm("BrowserOS intent planner returned non-JSON output; using fallback.");
          return fallbackPlan;
        }
        if (plannerPayload.ok === false) {
          logLlm("BrowserOS intent planner failed; using fallback.", {
            error: plannerPayload.error ?? null,
          });
          return fallbackPlan;
        }

        const resolvedType =
          normalizeSuggestionType(plannerPayload.suggestionType ?? "") ??
          suggestion.type;
        const resolvedQuery =
          typeof plannerPayload.query === "string" && plannerPayload.query.trim()
            ? plannerPayload.query.trim()
            : suggestion.query;
        const plannerStartUrl = normalizeUrl(
          typeof plannerPayload.startUrl === "string"
            ? plannerPayload.startUrl
            : ""
        );
        // For direct commands, prefer:
        // 1. URL explicitly mentioned in the command text (e.g. "go to arxiv.org/list/...")
        // 2. Planner's chosen URL (if it's a search URL, not just a homepage)
        // 3. Bing search from the resolved query as fallback
        const directCommandUrl = directCommand ? extractUrlFromText(directCommand) : null;
        // When the planner returns a generic search URL for a direct command
        // (i.e. it just searched for the command text), prefer the current page
        // URL — the user likely wants to act on the page they're already viewing.
        const lastPageUrl = lastBrowserOSPageUrlRef.current || null;
        const fallbackSearchUrl = buildSearchUrl(resolvedType, resolvedQuery);
        const plannerJustSearchedQuery =
          directCommand &&
          plannerStartUrl &&
          normalizeUrl(plannerStartUrl) === normalizeUrl(fallbackSearchUrl);
        const resolvedStartUrl = directCommand
          ? directCommandUrl ??
            (plannerJustSearchedQuery && lastPageUrl ? lastPageUrl : plannerStartUrl) ??
            fallbackSearchUrl
          : plannerStartUrl ?? fallbackSearchUrl;
        const resolvedReasoning =
          typeof plannerPayload.reasoning === "string"
            ? plannerPayload.reasoning.trim()
            : "";
        const resolvedNarrative =
          typeof plannerPayload.narrative === "string" &&
          plannerPayload.narrative.trim()
            ? plannerPayload.narrative.trim()
            : narrative;
        const resolvedPrompts = buildDefaultBrowserOSPrompts({
          query: resolvedQuery,
          directCommand,
        });
        const resolvedSystemPrompt =
          typeof plannerPayload.browserosSystemPrompt === "string" &&
          plannerPayload.browserosSystemPrompt.trim()
            ? plannerPayload.browserosSystemPrompt.trim()
            : resolvedPrompts.browserosSystemPrompt;
        const resolvedPrompt =
          typeof plannerPayload.browserosPrompt === "string" &&
          plannerPayload.browserosPrompt.trim()
            ? plannerPayload.browserosPrompt.trim()
            : resolvedPrompts.browserosPrompt;
        const shouldFallbackToDefaultPrompt =
          !directCommand &&
          hasInventedPlannerPromptConstraints(resolvedPrompt, transcriptPayload);
        const finalSystemPrompt = shouldFallbackToDefaultPrompt
          ? resolvedPrompts.browserosSystemPrompt
          : resolvedSystemPrompt;
        const finalPrompt = shouldFallbackToDefaultPrompt
          ? resolvedPrompts.browserosPrompt
          : resolvedPrompt;
        if (shouldFallbackToDefaultPrompt) {
          logLlm("BrowserOS intent planner prompt normalized to default template.", {
            query: resolvedQuery,
            reason: "invented-constraints",
          });
        }

        const plannedSuggestion: Suggestion = {
          ...suggestion,
          type: resolvedType,
          query: resolvedQuery,
          note: resolvedReasoning
            ? truncateText(`Intent planner: ${resolvedReasoning}`, 220)
            : suggestion.note,
          url: resolvedStartUrl,
        };

        logLlm("BrowserOS intent planner response", {
          query: resolvedQuery,
          type: resolvedType,
          startUrl: resolvedStartUrl,
          reasoning: resolvedReasoning || null,
          modelName:
            typeof plannerPayload.modelName === "string"
              ? plannerPayload.modelName
              : null,
          modelSource:
            typeof plannerPayload.modelSource === "string"
              ? plannerPayload.modelSource
              : null,
        });

        const resolvedActionType =
          typeof plannerPayload.actionType === "string" &&
          plannerPayload.actionType.trim().toLowerCase() === "excalidraw"
            ? "excalidraw" as const
            : "browser" as const;
        const resolvedExcalidrawPrompt =
          typeof plannerPayload.excalidrawPrompt === "string"
            ? plannerPayload.excalidrawPrompt.trim()
            : "";
        const resolvedExcalidrawSystemPrompt =
          typeof plannerPayload.excalidrawSystemPrompt === "string"
            ? plannerPayload.excalidrawSystemPrompt.trim()
            : "";
        const plannerUserNote =
          typeof plannerPayload.userNote === "string"
            ? plannerPayload.userNote.trim()
            : "";

        const resolvedPlan: BrowserOSIntentPlan = {
          suggestion: plannedSuggestion,
          narrative: resolvedNarrative,
          browserosPrompt: finalPrompt,
          browserosSystemPrompt: finalSystemPrompt,
          plannerSource: "llm",
          plannerReasoning: resolvedReasoning,
          actionType: resolvedActionType,
          excalidrawPrompt: resolvedExcalidrawPrompt,
          excalidrawSystemPrompt: resolvedExcalidrawSystemPrompt,
          userNote: plannerUserNote,
        };

        // Cache the successful plan for reuse on same-topic restarts
        if (!directCommand) {
          lastIntentPlanCacheRef.current = {
            plan: resolvedPlan,
            query: resolvedQuery,
            infoTokens: extractInformativeTokens(transcriptPayload),
            actionType: resolvedActionType,
            timestamp: Date.now(),
          };
        } else {
          // Direct commands invalidate the cache
          lastIntentPlanCacheRef.current = null;
        }

        return resolvedPlan;
      } catch (error) {
        logLlm("BrowserOS intent planner call failed; using fallback.", {
          error: String(error),
        });
        return fallbackPlan;
      }
    },
    [logLlm]
  );

  const runBrowserOSFollowUp = React.useCallback(
    (
      suggestion: Suggestion,
      transcriptPayload: string,
      narrative: string,
      options?: { directCommand?: string; trigger?: BrowserOSTriggerContext; latestSpeech?: string }
    ) => {
      if (browserosInFlightRef.current) {
        pendingBrowserOSReplayRef.current = true;
        return false;
      }

      const settings = loadOpenRouterSettings();
      if (!hasOpenRouterKey(settings)) {
        logLlm("BrowserOS automation skipped: OpenRouter is not configured.");
        return false;
      }

      const directCommand = options?.directCommand?.trim() ?? "";
      const hasDirectCommand = Boolean(directCommand);
      const triggerReason = options?.trigger?.reason ?? "topic-shift";
      const triggerUtterance = options?.trigger?.utterance?.trim() ?? "";
      const triggerUtteranceIndex =
        typeof options?.trigger?.utteranceIndex === "number" &&
        Number.isFinite(options.trigger.utteranceIndex)
          ? Math.max(1, Math.floor(options.trigger.utteranceIndex))
          : null;
      setSuggestionsLoadingState(true, "Planning browser deep dive...");
      browserosInFlightRef.current = true;
      browserosRunStartedAtRef.current = Date.now();

      browserosRunPromiseRef.current = (async () => {
        let effectiveSuggestion = suggestion;
        let effectiveNarrative = narrative;
        let resolvedStartUrl = suggestion.url ?? buildSearchUrl(suggestion.type, suggestion.query);
        let didDispatchBrowserOSRequest = false;
        let browserosRunIndex = 0;
        const userNotesForPrompt = formatUserNotesForPrompt(loadUserNotes());
        try {
          const intentPlan = await resolveBrowserOSIntentPlan({
            suggestion,
            transcriptPayload,
            narrative,
            directCommand,
            latestSpeech: options?.latestSpeech,
          });
          effectiveSuggestion = intentPlan.suggestion;
          effectiveNarrative = intentPlan.narrative;

          if (browserosRunCancelledRef.current) {
            return; // finally block handles cleanup
          }

          if (intentPlan.userNote) {
            addUserNote(intentPlan.userNote);
            logLlm("User note saved from direct command.", { note: intentPlan.userNote });
          }

          // --- Excalidraw routing ---
          if (intentPlan.actionType === "excalidraw") {
            logLlm("Intent planner chose excalidraw action.", {
              query: effectiveSuggestion.query,
              excalidrawPrompt: intentPlan.excalidrawPrompt || null,
              plannerReasoning: intentPlan.plannerReasoning || null,
            });
            activeTaskTypeRef.current = "excalidraw";
            await focusChromeTab("http://localhost:3000");
            setActiveTopic(effectiveSuggestion);
            setSuggestionsLoadingState(true, "Creating Excalidraw diagram...");
            if (effectiveNarrative.trim()) {
              setSuggestionsNarrative(effectiveNarrative.trim());
            }

            excalidrawRunsStartedRef.current += 1;
            excalidrawRunsPendingRef.current += 1;
            didDispatchBrowserOSRequest = true;

            // Open the Excalidraw canvas tab before the first run so the MCP can connect
            if (excalidrawRunsStartedRef.current === 1) {
              if (excalidrawCanvasPreloadedRef.current) {
                // Canvas was pre-opened during initial topic detection — shorter init wait
                await new Promise((r) => setTimeout(r, 500));
              } else {
                const canvasUrl = "http://localhost:3000";
                await openSuggestionUrl(canvasUrl);
                // Give the canvas a moment to initialize before automation
                await new Promise((r) => setTimeout(r, 1500));
              }
            }

            appendTestLogEvent({
              event: "excalidraw-request",
              triggerReason,
              triggerUtterance: triggerUtterance || null,
              triggerUtteranceIndex,
              query: effectiveSuggestion.query,
              excalidrawPrompt: intentPlan.excalidrawPrompt || null,
              plannerSource: intentPlan.plannerSource,
              plannerReasoning: intentPlan.plannerReasoning || null,
            });

            try {
              const excalidrawContent = await invoke<string>("run_llm_agent", {
                payload: {
                  mode: "excalidraw-act",
                  settings: {
                    apiKey: settings.apiKey,
                    model: settings.model,
                    reasoning: settings.reasoning,
                  },
                  instructions:
                    (intentPlan.excalidrawSystemPrompt ||
                    "You are HeyJamie's Excalidraw diagram creator. Use MCP tools to create diagrams.") + userNotesForPrompt,
                  prompt: intentPlan.excalidrawPrompt || effectiveSuggestion.query,
                  context: {
                    topic: effectiveSuggestion.query,
                    excalidrawPrompt: intentPlan.excalidrawPrompt,
                    narrative: effectiveNarrative,
                    clearCanvas: true,
                    transcript: truncateText(
                      transcriptPayload,
                      MAX_BROWSEROS_TRANSCRIPT_CHARS
                    ),
                  },
                },
              });

              let excalidrawResult: Record<string, unknown> = {};
              try {
                excalidrawResult = JSON.parse(excalidrawContent) as Record<string, unknown>;
              } catch {
                const extracted = extractJsonPayload(excalidrawContent);
                if (extracted && typeof extracted === "object") {
                  excalidrawResult = extracted as Record<string, unknown>;
                }
              }

              const diagramUrl =
                typeof excalidrawResult.diagramUrl === "string"
                  ? excalidrawResult.diagramUrl.trim()
                  : "";
              const excalidrawOk = Boolean(excalidrawResult.ok) && Boolean(diagramUrl);
              const excalidrawMessage =
                typeof excalidrawResult.message === "string" && excalidrawResult.message.trim()
                  ? excalidrawResult.message.trim()
                  : diagramUrl
                    ? `Created an Excalidraw diagram for "${effectiveSuggestion.query}". ${diagramUrl}`
                    : `Attempted to create an Excalidraw diagram for "${effectiveSuggestion.query}".`;

              setSuggestionsNarrative(excalidrawMessage);

              addSuggestionLogEntry({
                narrative: excalidrawMessage,
                toolCalls: [
                  {
                    id: crypto.randomUUID(),
                    name: "excalidraw.agent.execute",
                    input: {
                      topic: effectiveSuggestion.query,
                      excalidrawPrompt: intentPlan.excalidrawPrompt,
                    },
                    output: excalidrawResult,
                  },
                ],
                suggestions: [effectiveSuggestion],
              });

              const excalidrawError =
                typeof excalidrawResult.error === "string" ? excalidrawResult.error : null;
              const excalidrawToolCalls = Array.isArray(excalidrawResult.toolCalls)
                ? excalidrawResult.toolCalls as Array<{ name?: string }>
                : [];
              logLlm("Excalidraw automation completed.", {
                ok: excalidrawOk,
                diagramUrl: diagramUrl || null,
                error: excalidrawError,
                toolCallCount: excalidrawToolCalls.length,
                toolNames: excalidrawToolCalls.map((c) => c.name).join(",") || null,
                modelName: typeof excalidrawResult.modelName === "string" ? excalidrawResult.modelName : null,
              });
              appendTestLogEvent({
                event: "excalidraw-response",
                triggerReason,
                triggerUtterance: triggerUtterance || null,
                triggerUtteranceIndex,
                query: effectiveSuggestion.query,
                ok: excalidrawOk,
                diagramUrl: diagramUrl || null,
                message: truncateText(excalidrawMessage, 260),
                contentSnapshot: typeof excalidrawResult.contentSnapshot === "string"
                  ? excalidrawResult.contentSnapshot : null,
              });
              if (excalidrawOk) {
                excalidrawRunsSucceededRef.current += 1;
              } else {
                excalidrawRunsFailedRef.current += 1;
              }
            } catch (error) {
              logLlm("Excalidraw automation failed.", { error: String(error) });
              setSuggestionsNarrative(
                `Excalidraw diagram creation failed for "${effectiveSuggestion.query}". Falling back to browser.`
              );
              excalidrawRunsFailedRef.current += 1;
              appendTestLogEvent({
                event: "excalidraw-error",
                triggerReason,
                triggerUtterance: triggerUtterance || null,
                triggerUtteranceIndex,
                query: effectiveSuggestion.query,
                error: String(error),
              });
            } finally {
              excalidrawRunsPendingRef.current = Math.max(
                0,
                excalidrawRunsPendingRef.current - 1
              );
              maybeFinalizeIntegrationTestRun();
            }
            return;
          }

          const suggestionUrl =
            effectiveSuggestion.url ??
            buildSearchUrl(effectiveSuggestion.type, effectiveSuggestion.query);
          // When the LLM planner explicitly provides a startUrl, prefer it
          // over lastBrowserOSPageUrl. The planner has already considered the
          // direct command context and can choose a better starting page
          // (e.g. a site-specific search URL rather than a long listing page).
          // However, if the planner just returned a generic search for the
          // command text (identical to the fallback), it didn't add value —
          // prefer the current page URL for direct commands.
          const plannerChoseUrl =
            intentPlan.plannerSource === "llm" && isHttpUrl(suggestionUrl);
          const fallbackUrl = buildSearchUrl(effectiveSuggestion.type, effectiveSuggestion.query);
          const isSearchEngineUrl = /^https?:\/\/(www\.)?(google|bing|duckduckgo|yahoo)\.\w+\/search/i.test(suggestionUrl);
          const isSpecializedSearch = isSearchEngineUrl && /[?&]tbm=/i.test(suggestionUrl);
          const plannerAddedValue =
            plannerChoseUrl &&
            normalizeUrl(suggestionUrl) !== normalizeUrl(fallbackUrl) &&
            !(hasDirectCommand && isSearchEngineUrl && !isSpecializedSearch);
          const directCommandStartUrlCandidates = plannerAddedValue
            ? [suggestionUrl, lastBrowserOSPageUrlRef.current, activeTopic?.url ?? ""]
            : [lastBrowserOSPageUrlRef.current, activeTopic?.url ?? "", suggestionUrl];
          resolvedStartUrl = hasDirectCommand
            ? directCommandStartUrlCandidates.find((candidate) => isHttpUrl(candidate)) ?? ""
            : suggestionUrl;
          if (!isHttpUrl(resolvedStartUrl)) {
            logLlm("BrowserOS automation skipped: missing valid start URL.", {
              suggestionQuery: effectiveSuggestion.query,
              hasDirectCommand,
              lastBrowserOSPageUrl: lastBrowserOSPageUrlRef.current || null,
              activeTopicUrl: activeTopic?.url ?? null,
              suggestionUrl: suggestionUrl || null,
            });
            return;
          }

          const taskKey = hasDirectCommand
            ? `direct::${resolvedStartUrl.toLowerCase()}::${directCommand.toLowerCase()}`
            : `${resolvedStartUrl}::${effectiveSuggestion.query.trim().toLowerCase()}::`;
          if (lastBrowserOSTaskRef.current === taskKey) {
            return;
          }

          activeTaskTypeRef.current = "browser";
          setActiveTopic(effectiveSuggestion);
          if (effectiveNarrative.trim()) {
            setSuggestionsNarrative(effectiveNarrative.trim());
          }
          setSuggestionsLoadingState(true, "Running browser deep dive...");

          logLlm("BrowserOS automation request", {
            query: effectiveSuggestion.query,
            url: resolvedStartUrl,
            type: effectiveSuggestion.type,
            rating: effectiveSuggestion.rating ?? null,
            directCommand: hasDirectCommand ? directCommand : null,
            plannerSource: intentPlan.plannerSource,
            plannerReasoning: intentPlan.plannerReasoning || null,
            startUrlSource: hasDirectCommand
              ? plannerAddedValue
                ? "planner"
                : isHttpUrl(lastBrowserOSPageUrlRef.current)
                  ? "last-browseros-page"
                  : isHttpUrl(activeTopic?.url ?? "")
                    ? "active-topic"
                    : "suggestion"
              : "suggestion",
          });
          browserosRunIndex = browserosRunCountRef.current;
          browserosRunCountRef.current += 1;
          appendTestLogEvent({
            event: "browseros-request",
            triggerReason,
            triggerUtterance: triggerUtterance || null,
            triggerUtteranceIndex,
            suggestionType: effectiveSuggestion.type,
            query: effectiveSuggestion.query,
            startUrl: resolvedStartUrl,
            directCommand: hasDirectCommand ? directCommand : null,
            plannerSource: intentPlan.plannerSource,
            plannerReasoning: intentPlan.plannerReasoning || null,
            browserosRunIndex,
          });
          browserosRunsStartedRef.current += 1;
          browserosRunsPendingRef.current += 1;
          didDispatchBrowserOSRequest = true;

          const executeBrowserOSRun = async (retryAfterBrowserOpen: boolean) => {
            const content = await invoke<string>("run_llm_agent", {
              payload: {
                mode: "browseros-act",
                settings: {
                  apiKey: settings.apiKey,
                  model: settings.model,
                  reasoning: settings.reasoning,
                },
                instructions: intentPlan.browserosSystemPrompt + userNotesForPrompt,
                prompt: intentPlan.browserosPrompt,
                context: {
                  url: resolvedStartUrl,
                  query: effectiveSuggestion.query,
                  note: effectiveSuggestion.note,
                  suggestionType: effectiveSuggestion.type,
                  rating: effectiveSuggestion.rating ?? null,
                  narrative: effectiveNarrative,
                  directCommand: hasDirectCommand ? directCommand : undefined,
                  forceFreshBrowser: browserosRunIndex === 0,
                  browserosRunIndex,
                  retryAfterBrowserOpen,
                  transcript: truncateText(
                    transcriptPayload,
                    MAX_BROWSEROS_TRANSCRIPT_CHARS
                  ),
                },
              },
            });

            let parsedResult: unknown = content;
            try {
              parsedResult = JSON.parse(content);
            } catch {
              const extracted = extractJsonPayload(content);
              if (extracted) {
                parsedResult = extracted;
              }
            }

            const resultObject =
              parsedResult && typeof parsedResult === "object"
                ? (parsedResult as Record<string, unknown>)
                : null;
            const ok = Boolean(resultObject?.ok);
            const errorBlob = JSON.stringify(resultObject ?? parsedResult).toLowerCase();
            const helperNotConnected =
              errorBlob.includes("helper service not connected") ||
              errorBlob.includes("mcp service is not connected");
            const mcpServerNotConnected =
              errorBlob.includes("mcp server is not connected") ||
              errorBlob.includes("mcp server not connected") ||
              errorBlob.includes("browseros mcp server is not connected") ||
              errorBlob.includes("chrome devtools mcp server is not connected") ||
              errorBlob.includes("chrome-devtools mcp");
            const providerReturnedError =
              errorBlob.includes("provider returned error") ||
              errorBlob.includes("rate limit") ||
              errorBlob.includes("temporarily unavailable");

            return {
              parsedResult,
              resultObject,
              ok,
              helperNotConnected,
              mcpServerNotConnected,
              providerReturnedError,
            };
          };

          // Record a chapter for this browser-automation topic.  This fires
          // before awaiting the result so chapters are captured even when the
          // automation is later cancelled by a topic shift.  The existing
          // 30-second deduplication in recordChapter prevents spam.
          const urlVisitFallbackTitle = toTitleCase(effectiveSuggestion.query);
          const urlVisitChapterId = recordChapter({
            title: urlVisitFallbackTitle,
            timestamp: Date.now(),
            transcriptIndex: transcriptsRef.current.length,
            source: "url-visit",
          });
          if (urlVisitChapterId) {
            const urlVisitContext = [
              effectiveSuggestion.query,
              effectiveSuggestion.note ?? "",
              effectiveNarrative,
            ].filter(Boolean).join("\n");
            refineChapterTitle(urlVisitChapterId, urlVisitContext, urlVisitFallbackTitle);
          }

          if (hasDirectCommand || browserWindowOpenedRef.current) {
            await focusChrome();
          } else {
            await openBrowserWindow(resolvedStartUrl);
          }

          if (isHttpUrl(resolvedStartUrl)) {
            lastBrowserOSPageUrlRef.current = resolvedStartUrl;
            addUrlToCurrentChapter(resolvedStartUrl);
          }

          let {
            parsedResult: browserosResult,
            resultObject: browserosResultObject,
            ok,
            helperNotConnected,
            mcpServerNotConnected,
            providerReturnedError,
          } = await executeBrowserOSRun(false);
          let recoveryBrowserOpened = false;

          if (!ok && (helperNotConnected || mcpServerNotConnected || providerReturnedError)) {
            const shouldOpenBrowserForRecovery =
              helperNotConnected || mcpServerNotConnected;
            logLlm(
              shouldOpenBrowserForRecovery
                ? "BrowserOS connection issue detected; opening browser window and retrying."
                : "BrowserOS provider error detected; retrying automation.",
              {
                query: effectiveSuggestion.query,
                url: resolvedStartUrl,
                helperNotConnected,
                mcpServerNotConnected,
                providerReturnedError,
              }
            );
            if (shouldOpenBrowserForRecovery) {
              recoveryBrowserOpened = await openSuggestionUrl(resolvedStartUrl);
              logLlm(
                recoveryBrowserOpened
                  ? "Opened browser window before BrowserOS retry."
                  : "Unable to open browser window before BrowserOS retry.",
                {
                  query: effectiveSuggestion.query,
                  url: resolvedStartUrl,
                }
              );
            }

            const retryDelaysMs = mcpServerNotConnected
              ? [1800, 2800]
              : providerReturnedError
                ? [1200, 2200]
                : [1200];
            for (let retryAttempt = 0; retryAttempt < retryDelaysMs.length; retryAttempt += 1) {
              if (browserosRunCancelledRef.current) break;
              const waitMs = retryDelaysMs[retryAttempt];
              await new Promise((resolve) => window.setTimeout(resolve, waitMs));
              ({
                parsedResult: browserosResult,
                resultObject: browserosResultObject,
                ok,
                helperNotConnected,
                mcpServerNotConnected,
                providerReturnedError,
              } = await executeBrowserOSRun(true));
              logLlm("BrowserOS retry completed.", {
                query: effectiveSuggestion.query,
                ok,
                helperNotConnected,
                mcpServerNotConnected,
                providerReturnedError,
                retryAttempt: retryAttempt + 1,
              });
              if (ok) break;
              if (
                !helperNotConnected &&
                !mcpServerNotConnected &&
                !providerReturnedError
              ) {
                break;
              }
            }
          }

          const browserosEndUrl =
            typeof browserosResultObject?.endUrl === "string"
              ? browserosResultObject.endUrl.trim()
              : "";
          const browserosStartUrl =
            typeof browserosResultObject?.startUrl === "string"
              ? browserosResultObject.startUrl.trim()
              : "";
          if (isHttpUrl(browserosEndUrl)) {
            lastBrowserOSPageUrlRef.current = browserosEndUrl;
            addUrlToCurrentChapter(browserosEndUrl);
          } else if (isHttpUrl(browserosStartUrl)) {
            lastBrowserOSPageUrlRef.current = browserosStartUrl;
            addUrlToCurrentChapter(browserosStartUrl);
          } else if (isHttpUrl(resolvedStartUrl)) {
            lastBrowserOSPageUrlRef.current = resolvedStartUrl;
            addUrlToCurrentChapter(resolvedStartUrl);
          }

          const responsePreview =
            typeof browserosResult === "string"
              ? browserosResult
              : JSON.stringify(browserosResult);

          logLlm("BrowserOS automation response", {
            query: effectiveSuggestion.query,
            ok,
            responsePreview: truncateText(responsePreview, 1200),
          });
          appendTestLogEvent({
            event: "browseros-response",
            triggerReason,
            triggerUtterance: triggerUtterance || null,
            triggerUtteranceIndex,
            query: effectiveSuggestion.query,
            suggestionType: effectiveSuggestion.type,
            startUrl: resolvedStartUrl,
            endUrl: browserosEndUrl || browserosStartUrl || resolvedStartUrl,
            ok,
            message:
              browserosResultObject &&
              typeof browserosResultObject.message === "string"
                ? truncateText(browserosResultObject.message, 260)
                : null,
            actions: summarizeBrowserOSActionsForTestLog(
              browserosResultObject?.actions
            ),
            browserosRunIndex,
            contentSnapshot: typeof browserosResultObject?.contentSnapshot === "string"
              ? browserosResultObject.contentSnapshot : null,
          });
          if (ok) {
            browserosRunsSucceededRef.current += 1;
          } else {
            browserosRunsFailedRef.current += 1;
          }

          const summary =
            typeof browserosResult === "object" &&
            browserosResult !== null &&
            typeof (browserosResult as any).message === "string" &&
            (browserosResult as any).message.trim()
              ? (browserosResult as any).message.trim()
              : ok
                ? hasDirectCommand
                  ? `Completed direct command: "${directCommand}".`
                  : `Completed follow-up browsing for "${effectiveSuggestion.query}".`
                : hasDirectCommand
                  ? `Attempted direct command: "${directCommand}".`
                  : `Attempted follow-up browsing for "${effectiveSuggestion.query}".`;
          setSuggestionsNarrative(summary);

          addSuggestionLogEntry({
            narrative: summary,
            toolCalls: [
              {
                id: crypto.randomUUID(),
                name: "browseros.agent.execute",
                input: {
                  url: resolvedStartUrl,
                  query: effectiveSuggestion.query,
                  type: effectiveSuggestion.type,
                  note: effectiveSuggestion.note,
                  directCommand: hasDirectCommand ? directCommand : null,
                },
                output: browserosResult,
              },
            ],
            suggestions: [effectiveSuggestion],
          });

          if (ok) {
            lastBrowserOSTaskRef.current = taskKey;
            focusChrome().catch(() => {});
          } else {
            const keepOpenOnError =
              browserosResultObject?.keepOpenOnError === true;
            const browserosEndUrlValue =
              typeof browserosResultObject?.endUrl === "string" &&
              browserosResultObject.endUrl.trim().length > 0
                ? browserosResultObject.endUrl.trim()
                : "";
            const hasDistinctBrowserOSEndUrl =
              Boolean(browserosEndUrlValue) &&
              browserosEndUrlValue.toLowerCase() !== resolvedStartUrl.toLowerCase();
            // Also skip the osascript fallback when the error indicates Chrome/MCP is
            // broken (e.g. "Target closed") — opening a new tab won't help.
            const isChromeConnectionError =
              typeof browserosResultObject?.error === "string" &&
              /target closed|protocol error|connection/i.test(browserosResultObject.error);
            const isChromeConnectionMessage =
              typeof browserosResultObject?.message === "string" &&
              /target closed|protocol error/i.test(browserosResultObject.message);
            const shouldSkipFallback =
              keepOpenOnError || hasDistinctBrowserOSEndUrl || isChromeConnectionError || isChromeConnectionMessage || browserosRunCancelledRef.current;
            if (shouldSkipFallback) {
              logLlm("BrowserOS fallback skipped: browser already open.", {
                query: effectiveSuggestion.query,
                url: resolvedStartUrl,
                keepOpenOnError,
                endUrl:
                  typeof browserosResultObject?.endUrl === "string"
                    ? browserosResultObject.endUrl
                    : null,
              });
              lastBrowserOSTaskRef.current = taskKey;
            } else {
              const opened =
                recoveryBrowserOpened || (await openSuggestionUrl(resolvedStartUrl));
              logLlm(
                opened
                  ? "BrowserOS fallback opened browser window."
                  : "BrowserOS fallback could not open browser window.",
                {
                  query: effectiveSuggestion.query,
                  url: resolvedStartUrl,
                }
              );
            }
          }
        } catch (error) {
          logLlm("BrowserOS automation failed.", { error: String(error) });
          if (didDispatchBrowserOSRequest) {
            browserosRunsFailedRef.current += 1;
          }
          appendTestLogEvent({
            event: "browseros-error",
            triggerReason,
            triggerUtterance: triggerUtterance || null,
            triggerUtteranceIndex,
            query: effectiveSuggestion.query,
            startUrl: resolvedStartUrl,
            error: String(error),
            browserosRunIndex,
          });
          const errorStr = String(error);
          const isChromeError = /target closed|protocol error|connection/i.test(errorStr);
          const shouldSuppressFallback = isChromeError || browserosRunCancelledRef.current;
          const opened = shouldSuppressFallback ? false : await openSuggestionUrl(resolvedStartUrl);
          logLlm(
            isChromeError
              ? "BrowserOS fallback suppressed: Chrome/MCP connection error."
              : opened
                ? "BrowserOS fallback opened browser window after error."
                : "BrowserOS fallback could not open browser window after error.",
            {
              query: effectiveSuggestion.query,
              url: resolvedStartUrl,
            }
          );
        } finally {
          browserosRunPromiseRef.current = null;
          if (didDispatchBrowserOSRequest) {
            browserosRunsPendingRef.current = Math.max(
              0,
              browserosRunsPendingRef.current - 1
            );
          }
          browserosInFlightRef.current = false;
          inFlightDirectCommandRef.current = "";
          if (triggerReason === "topic-shift") {
            lastDeepDiveCompletedAtRef.current = Date.now();
          }
          setSuggestionsLoadingState(false);
          maybeFinalizeIntegrationTestRun();
          if (pendingBrowserOSReplayRef.current) {
            pendingBrowserOSReplayRef.current = false;
            window.setTimeout(() => {
              runBrowserOSDeepDiveRef.current();
            }, 60);
          }
        }
      })();

      return true;
    },
    [
      activeTopic,
      addSuggestionLogEntry,
      appendTestLogEvent,
      logLlm,
      addUrlToCurrentChapter,
      maybeFinalizeIntegrationTestRun,
      openSuggestionUrl,
      resolveBrowserOSIntentPlan,
      setSuggestionsLoadingState,
    ]
  );

  const addTranscript = React.useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const entry: TranscriptEntry = {
      id: crypto.randomUUID(),
      text: trimmed,
      timestamp: Date.now(),
    };
    const transcriptIndex = transcriptsRef.current.length + 1;
    setTranscripts((prev) => {
      const next = [...prev, entry];
      transcriptsRef.current = next;
      return next;
    });
    ensureSessionStart(entry.timestamp);
    if (chaptersRef.current.length === 0) {
      const introFallback = buildChapterTitleFromTranscript(trimmed);
      const introChapterId = recordChapter({
        title: introFallback,
        timestamp: entry.timestamp,
        transcriptIndex,
        source: "intro",
      });
      if (introChapterId) {
        refineChapterTitle(introChapterId, trimmed, introFallback);
      }
    }
    updateChaptersFromTranscript();
    return entry;
  }, [ensureSessionStart, recordChapter, refineChapterTitle, updateChaptersFromTranscript]);

  const buildTranscriptPayload = React.useCallback(() => {
    return transcriptsRef.current
      .map((entry, index) => `${index + 1}. ${entry.text}`)
      .join("\n");
  }, []);

  const buildDeepDiveSuggestion = React.useCallback(
    (text: string): Suggestion => {
      const cleaned = text.replace(/\s+/g, " ").trim();
      const lower = cleaned.toLowerCase();
      const type: SuggestionType = /\b(image|images|photo|photos|picture|pictures|pic|pics)\b/.test(
        lower
      )
        ? "Image"
        : /\b(video|videos|youtube|clip|watch)\b/.test(lower)
          ? "Video"
          : /\b(news|headline|headlines|breaking|today|latest|update)\b/.test(
                lower
              )
            ? "News"
            : "Search";

      const extractedSearchQuery = buildSearchQueryFromTranscript(cleaned);
      const fallbackTokens = tokenizeQueryTerms(lower).slice(-18);
      const fallbackQuery = fallbackTokens.slice(0, 12).join(" ");

      const query =
        extractedSearchQuery ||
        fallbackQuery ||
        truncateText(cleaned || "current conversation topic", 120);

      return {
        id: crypto.randomUUID(),
        type,
        query,
        note: "Deep-dive topic derived from transcript intent parsing.",
        url: buildSearchUrl(type, query),
        rating: 5,
      };
    },
    []
  );

  const buildDeepDiveNarrative = React.useCallback(
    (transcriptPayload: string, suggestion: Suggestion): string => {
      const context = transcriptPayload
        .split("\n")
        .slice(-4)
        .map((line) => line.replace(/^\d+\.\s*/, ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const contextSnippet = truncateText(context, 260);
      return `Deep-dive narrative: investigate "${suggestion.query}" from the latest transcript context. ${contextSnippet}`;
    },
    []
  );

  const runBrowserOSDeepDive = React.useCallback(async () => {
    const settings = loadOpenRouterSettings();
    if (!hasOpenRouterKey(settings)) {
      logLlm("BrowserOS deep dive skipped: OpenRouter key missing.");
      return;
    }

    const transcriptLines = transcriptsRef.current;
    const transcriptTextLines = getTranscriptTexts(transcriptLines);
    const transcriptPayload = buildTranscriptPayload();
    if (!transcriptPayload.trim()) return;
    if (transcriptPayload === lastSuggestionTranscriptRef.current) return;

    const heyJamieCommand = extractLatestHeyJamieCommand(transcriptTextLines);
    if (heyJamieCommand) {
      const commandKey = `${heyJamieCommand.transcriptLineIndex}:${heyJamieCommand.command.toLowerCase()}`;
      if (commandKey !== lastHeyJamieCommandKeyRef.current) {
        logLlm("Direct BrowserOS command detected in transcript.", {
          command: heyJamieCommand.command,
          transcriptLine: heyJamieCommand.transcriptLine,
          transcriptLineIndex: heyJamieCommand.transcriptLineIndex,
        });
        // Claim the command key immediately (before any awaits) to prevent
        // concurrent runBrowserOSDeepDive calls from re-processing the same command.
        lastHeyJamieCommandKeyRef.current = commandKey;
        const commandEntry = transcriptLines[heyJamieCommand.transcriptLineIndex];
        if (commandEntry) {
          const cmdFallback = buildChapterTitleFromTranscript(heyJamieCommand.command);
          const cmdChapterId = recordChapter({
            title: cmdFallback,
            timestamp: commandEntry.timestamp,
            transcriptIndex: heyJamieCommand.transcriptLineIndex + 1,
            source: "direct-command",
          });
          if (cmdChapterId) {
            refineChapterTitle(cmdChapterId, heyJamieCommand.command, cmdFallback);
          }
        }

        const directSuggestion = buildFallbackSuggestionFromDirectCommand(
          heyJamieCommand.command
        );
        const narrative = `Direct command from transcript: "${heyJamieCommand.command}".`;
        if (browserosInFlightRef.current) {
          // If the in-flight run is already executing a similar command
          // (user repeating themselves), let it continue instead of cancelling.
          if (areDirectCommandsSimilar(inFlightDirectCommandRef.current, heyJamieCommand.command)) {
            logLlm("BrowserOS: ignoring repeated direct command while similar command is in-flight.", {
              command: heyJamieCommand.command,
              inFlightCommand: inFlightDirectCommandRef.current,
            });
            return;
          }
          logLlm("BrowserOS: cancelling in-flight run for direct command.", {
            command: heyJamieCommand.command,
          });
          browserosRunCancelledRef.current = true;
          pendingBrowserOSReplayRef.current = false;
          try { await invoke("cancel_llm_agent"); } catch { /* best-effort */ }
          await awaitWithTimeout(browserosRunPromiseRef.current, 5000);
          browserosInFlightRef.current = false;
          browserosRunCancelledRef.current = false;
          inFlightDirectCommandRef.current = "";
          setSuggestionsLoadingState(false);
        }
        inFlightDirectCommandRef.current = heyJamieCommand.command;
        const started = runBrowserOSFollowUp(
          directSuggestion,
          transcriptPayload,
          narrative,
          {
            directCommand: heyJamieCommand.command,
            trigger: {
              reason: "direct-command",
              utterance: heyJamieCommand.transcriptLine,
              utteranceIndex: heyJamieCommand.transcriptLineIndex + 1,
            },
          }
        );
        if (!started) {
          inFlightDirectCommandRef.current = "";
          logLlm("Direct BrowserOS command skipped: unable to start BrowserOS run.", {
            command: heyJamieCommand.command,
            query: directSuggestion.query,
            suggestionType: directSuggestion.type,
          });
          return;
        }

        hasTriggeredDeepDiveRef.current = true;
        lastSuggestionTranscriptRef.current = transcriptPayload;
        lastSuggestionTranscriptLineCountRef.current = transcriptLines.length;
        lastSuggestionInfoTokensRef.current = extractInformativeTokens(
          transcriptPayload
        );
        lastSuggestionNumericTokensRef.current = extractNumericTokens(
          transcriptPayload
        );
        return;
      }
    }

    const hasPreviousDeepDive = hasTriggeredDeepDiveRef.current;
    const newTranscriptLines = transcriptTextLines.slice(
      lastSuggestionTranscriptLineCountRef.current
    );
    if (newTranscriptLines.length === 0) {
      lastSuggestionTranscriptRef.current = transcriptPayload;
      return;
    }
    const newTranscriptPayload = newTranscriptLines.join("\n");
    const topicCheckReadiness = computeTopicCheckReadiness(newTranscriptPayload);
    const hasInitialTopicContext =
      !hasPreviousDeepDive &&
      topicCheckReadiness.informativeTokenCount >= MIN_INITIAL_TOPIC_INFO_TOKENS &&
      topicCheckReadiness.anchorTokenCount > 0 &&
      (topicCheckReadiness.newTranscriptWordCount >= MIN_INITIAL_TOPIC_WORDS ||
        topicCheckReadiness.newTranscriptCharCount >= MIN_INITIAL_TOPIC_CHARS ||
        topicCheckReadiness.sentenceBoundaryCount >= 1);
    if (!topicCheckReadiness.hasEnoughContext && !hasInitialTopicContext) {
      logLlm(
        "BrowserOS deep dive deferred: awaiting more transcript context before topic-shift check.",
        {
          transcriptChars: transcriptPayload.length,
          newTranscriptLines: newTranscriptLines.length,
          newTranscriptChars: topicCheckReadiness.newTranscriptCharCount,
          newTranscriptWordCount: topicCheckReadiness.newTranscriptWordCount,
          sentenceBoundaryCount: topicCheckReadiness.sentenceBoundaryCount,
          nonEmptyLineCount: topicCheckReadiness.nonEmptyLineCount,
          informativeTokenCount: topicCheckReadiness.informativeTokenCount,
          anchorTokenCount: topicCheckReadiness.anchorTokenCount,
          hasTopicShiftCue: topicCheckReadiness.hasTopicShiftCue,
        }
      );
      lastSuggestionTranscriptRef.current = transcriptPayload;
      return;
    }
    if (!hasPreviousDeepDive && hasInitialTopicContext) {
      logLlm(
        "BrowserOS initial topic accepted with relaxed context gate.",
        {
          transcriptChars: transcriptPayload.length,
          newTranscriptLines: newTranscriptLines.length,
          newTranscriptChars: topicCheckReadiness.newTranscriptCharCount,
          newTranscriptWordCount: topicCheckReadiness.newTranscriptWordCount,
          sentenceBoundaryCount: topicCheckReadiness.sentenceBoundaryCount,
          informativeTokenCount: topicCheckReadiness.informativeTokenCount,
          anchorTokenCount: topicCheckReadiness.anchorTokenCount,
        }
      );
      // Pre-open excalidraw canvas in the background so it's ready when intent planner finishes
      if (!excalidrawCanvasPreloadedRef.current && hasExcalidrawKeywords(transcriptPayload)) {
        excalidrawCanvasPreloadedRef.current = true;
        logLlm("Pre-opening Excalidraw canvas for detected diagram topic.");
        void openSuggestionUrl("http://localhost:3000");
      }
    }

    const newInfoTokens = extractInformativeTokens(newTranscriptPayload);
    const newNumericTokens = extractNumericTokens(newTranscriptPayload);
    const newAnchorTokens = extractTopicAnchorTokens(newTranscriptPayload);
    const topicShiftDecision = computeTopicShiftDecision({
      newTranscriptPayload,
      newInfoTokens,
      newAnchorTokens,
      previousInfoTokens: lastSuggestionInfoTokensRef.current,
      activeTopicQuery: activeTopic?.query ?? null,
    });
    const topicShiftSensitivity = clampTopicShiftSensitivity(
      settings.topicShiftSensitivity ?? DEFAULT_TOPIC_SHIFT_SENSITIVITY
    );
    const baseRequiredTopicShiftScore = getTopicShiftScoreThreshold(
      topicShiftSensitivity
    );
    // When automation is in-flight, raise the threshold to reduce false cancellations
    const requiredTopicShiftScore = browserosInFlightRef.current
      ? baseRequiredTopicShiftScore + BROWSEROS_INFLIGHT_TOPIC_SHIFT_BOOST
      : baseRequiredTopicShiftScore;
    const shouldTriggerTopicShift =
      topicShiftDecision.hasTopicShift &&
      topicShiftDecision.topicShiftScore >= requiredTopicShiftScore;
    const isExcalidrawActive = activeTaskTypeRef.current === "excalidraw";
    if (hasPreviousDeepDive && !shouldTriggerTopicShift && !isExcalidrawActive) {
      logLlm(
        topicShiftDecision.hasTopicShift
          ? "BrowserOS deep dive skipped: topic shift below sensitivity threshold."
          : "BrowserOS deep dive skipped: no topic shift detected.",
        {
          transcriptChars: transcriptPayload.length,
          newTranscriptLines: newTranscriptLines.length,
          newTranscriptChars: topicCheckReadiness.newTranscriptCharCount,
          newTranscriptWordCount: topicCheckReadiness.newTranscriptWordCount,
          sentenceBoundaryCount: topicCheckReadiness.sentenceBoundaryCount,
          informativeTokenCount: topicCheckReadiness.informativeTokenCount,
          anchorTokenCount: topicCheckReadiness.anchorTokenCount,
          hasTopicShiftCue: topicCheckReadiness.hasTopicShiftCue,
          newTopicTokenCount: topicShiftDecision.newTopicTokenCount,
          newAnchorTopicTokenCount: topicShiftDecision.newAnchorTopicTokenCount,
          sharedTopicTokenCount: topicShiftDecision.sharedTopicTokenCount,
          topicNoveltyRatio: Number(topicShiftDecision.topicNoveltyRatio.toFixed(2)),
          hasTopicShiftByNovelty: topicShiftDecision.hasTopicShiftByNovelty,
          hasTopicShiftByStrongNovelty:
            topicShiftDecision.hasTopicShiftByStrongNovelty,
          hasTopicShiftByAnchorIntent: topicShiftDecision.hasTopicShiftByAnchorIntent,
          hasTopicShiftByExplicitCue: topicShiftDecision.hasTopicShiftByExplicitCue,
          hasTopicShiftByActiveTopicDivergence:
            topicShiftDecision.hasTopicShiftByActiveTopicDivergence,
          activeTopicOverlapRatio:
            topicShiftDecision.activeTopicOverlapRatio === null
              ? null
              : Number(topicShiftDecision.activeTopicOverlapRatio.toFixed(2)),
          newNumericTokenCount: newNumericTokens.size,
          topicShiftSensitivity,
          topicShiftScore: topicShiftDecision.topicShiftScore,
          requiredTopicShiftScore,
        }
      );
      lastSuggestionTranscriptRef.current = transcriptPayload;
      lastSuggestionTranscriptLineCountRef.current = transcriptLines.length;
      lastSuggestionInfoTokensRef.current = mergeTokenSets(
        lastSuggestionInfoTokensRef.current,
        newInfoTokens
      );
      lastSuggestionNumericTokensRef.current = mergeTokenSets(
        lastSuggestionNumericTokensRef.current,
        newNumericTokens
      );
      return;
    }
    // When excalidraw is active and heuristic shows potential shift (score >= 2),
    // use LLM to confirm topic shift before continuing with same topic
    if (hasPreviousDeepDive && isExcalidrawActive && !shouldTriggerTopicShift) {
      const shouldUseLLMDetection = topicShiftDecision.topicShiftScore >= 2;
      if (shouldUseLLMDetection) {
        logLlm("BrowserOS: using LLM to detect topic shift (excalidraw active).", {
          topicShiftScore: topicShiftDecision.topicShiftScore,
          requiredTopicShiftScore,
          activeTaskType: activeTaskTypeRef.current,
        });

        const llmResult = await detectTopicShiftWithLLM({
          activeTopicQuery: activeTopic?.query ?? null,
          activeTaskType: activeTaskTypeRef.current,
          recentTranscript: newTranscriptPayload,
        });

        if (llmResult?.hasTopicShift && llmResult.confidence >= 0.7) {
          logLlm("BrowserOS: LLM detected topic shift from excalidraw.", {
            newTopicSummary: llmResult.newTopicSummary,
            confidence: llmResult.confidence,
            suggestedActionType: llmResult.suggestedActionType,
            reasoning: llmResult.reasoning,
          });

          // Reset context to avoid contamination from old topic
          setActiveTopic(null);
          activeTaskTypeRef.current = null;
          lastSuggestionInfoTokensRef.current = new Set<string>();
          lastSuggestionNumericTokensRef.current = new Set<string>();
          lastIntentPlanCacheRef.current = null;
          browserWindowOpenedRef.current = false;

          // Build fresh suggestion from ONLY the new transcript
          const freshSuggestion = buildDeepDiveSuggestion(newTranscriptPayload);
          // Use LLM's topic summary if available and more specific
          if (
            llmResult.newTopicSummary &&
            llmResult.newTopicSummary.length > 3 &&
            llmResult.newTopicSummary.length < 100
          ) {
            freshSuggestion.query = llmResult.newTopicSummary;
          }
          const freshNarrative = buildDeepDiveNarrative(
            newTranscriptPayload,
            freshSuggestion
          );
          const triggerUtterance = (
            newTranscriptLines[newTranscriptLines.length - 1] ?? ""
          ).trim();
          const triggerUtteranceIndex = transcriptLines.length;

          if (browserosInFlightRef.current) {
            // Grace period: protect in-flight automation from premature cancellation.
            // Direct commands use a longer grace period but are still cancellable.
            const isDirectCommand = Boolean(inFlightDirectCommandRef.current && activeTaskTypeRef.current === "browser");
            const directCommandGracePeriodMs = BROWSEROS_GRACE_PERIOD_MS * 2;
            const runElapsedMs = Date.now() - browserosRunStartedAtRef.current;
            const effectiveGracePeriod = isDirectCommand ? directCommandGracePeriodMs : BROWSEROS_GRACE_PERIOD_MS;
            const withinGracePeriod = runElapsedMs < effectiveGracePeriod;
            if (withinGracePeriod && topicShiftDecision.topicShiftScore < 6) {
              logLlm("BrowserOS deep dive: skipping LLM cancellation — within grace period.", {
                newQuery: freshSuggestion.query,
                runElapsedMs,
                gracePeriodMs: effectiveGracePeriod,
                isDirectCommand,
                directCommand: isDirectCommand ? inFlightDirectCommandRef.current : null,
                topicShiftScore: topicShiftDecision.topicShiftScore,
              });
              lastSuggestionTranscriptRef.current = transcriptPayload;
              lastSuggestionTranscriptLineCountRef.current = transcriptLines.length;
              lastSuggestionInfoTokensRef.current = mergeTokenSets(
                lastSuggestionInfoTokensRef.current,
                newInfoTokens
              );
              lastSuggestionNumericTokensRef.current = mergeTokenSets(
                lastSuggestionNumericTokensRef.current,
                newNumericTokens
              );
              return;
            }
            logLlm(
              "BrowserOS deep dive: cancelling in-flight run for LLM-detected topic shift.",
              {
                newQuery: freshSuggestion.query,
                runElapsedMs,
                withinGracePeriod,
                topicShiftScore: topicShiftDecision.topicShiftScore,
              }
            );
            browserosRunCancelledRef.current = true;
            pendingBrowserOSReplayRef.current = false;
            try {
              await invoke("cancel_llm_agent");
            } catch {
              /* best-effort */
            }
            await awaitWithTimeout(browserosRunPromiseRef.current, 5000);
            browserosInFlightRef.current = false;
            browserosRunCancelledRef.current = false;
            inFlightDirectCommandRef.current = "";
            setSuggestionsLoadingState(false);
            // Debounce restart: schedule through debounce instead of restarting inline.
            // Use ref + timer to avoid circular dependency with scheduleBrowserOSDeepDive.
            if (browserosDeepDiveTimerRef.current) {
              window.clearTimeout(browserosDeepDiveTimerRef.current);
            }
            const restartDelayMs =
              loadOpenRouterSettings().evaluationDelayMs ?? DEFAULT_EVALUATION_DELAY_MS;
            browserosDeepDiveTimerRef.current = window.setTimeout(() => {
              browserosDeepDiveTimerRef.current = null;
              runBrowserOSDeepDiveRef.current();
            }, restartDelayMs);
            return;
          }

          const started = runBrowserOSFollowUp(
            freshSuggestion,
            newTranscriptPayload,
            freshNarrative,
            {
              trigger: {
                reason: "topic-shift",
                utterance: triggerUtterance,
                utteranceIndex: triggerUtteranceIndex,
              },
            }
          );
          if (started) {
            hasTriggeredDeepDiveRef.current = true;
            lastSuggestionTranscriptRef.current = newTranscriptPayload;
            lastSuggestionTranscriptLineCountRef.current =
              newTranscriptLines.length;
            lastSuggestionInfoTokensRef.current =
              extractInformativeTokens(newTranscriptPayload);
            lastSuggestionNumericTokensRef.current =
              extractNumericTokens(newTranscriptPayload);
          }
          return;
        } else {
          logLlm("BrowserOS: LLM did not confirm topic shift.", {
            hasTopicShift: llmResult?.hasTopicShift ?? false,
            confidence: llmResult?.confidence ?? 0,
          });
        }
      } else {
        logLlm("BrowserOS topic shift gate bypassed: excalidraw is active task.", {
          topicShiftScore: topicShiftDecision.topicShiftScore,
          requiredTopicShiftScore,
          activeTaskType: activeTaskTypeRef.current,
        });
      }
    }

    const cooldownMs = (settings.deepDiveCooldownSeconds ?? 0) * 1000;
    if (cooldownMs > 0 && lastDeepDiveCompletedAtRef.current > 0) {
      const elapsed = Date.now() - lastDeepDiveCompletedAtRef.current;
      if (elapsed < cooldownMs) {
        logLlm("BrowserOS deep dive skipped: cooldown period active.", {
          cooldownMs,
          elapsedMs: elapsed,
          remainingMs: cooldownMs - elapsed,
        });
        lastSuggestionTranscriptRef.current = transcriptPayload;
        lastSuggestionTranscriptLineCountRef.current = transcriptLines.length;
        lastSuggestionInfoTokensRef.current = mergeTokenSets(
          lastSuggestionInfoTokensRef.current,
          newInfoTokens
        );
        lastSuggestionNumericTokensRef.current = mergeTokenSets(
          lastSuggestionNumericTokensRef.current,
          newNumericTokens
        );
        return;
      }
    }

    const deepDiveSource = newTranscriptPayload.trim()
      ? newTranscriptPayload
      : transcriptPayload;
    const triggerUtterance = (
      newTranscriptLines[newTranscriptLines.length - 1] ?? ""
    ).trim();
    const triggerUtteranceIndex = transcriptLines.length;
    const suggestion = buildDeepDiveSuggestion(deepDiveSource);
    const narrative = buildDeepDiveNarrative(transcriptPayload, suggestion);
    if (browserosInFlightRef.current) {
      // Grace period: protect in-flight automation from premature cancellation.
      // Direct commands use a longer grace period but are still cancellable
      // once enough time has passed and the topic has clearly shifted.
      const isDirectCommand = Boolean(inFlightDirectCommandRef.current && activeTaskTypeRef.current === "browser");
      const directCommandGracePeriodMs = BROWSEROS_GRACE_PERIOD_MS * 2;
      const runElapsedMs = Date.now() - browserosRunStartedAtRef.current;
      const effectiveGracePeriod = isDirectCommand ? directCommandGracePeriodMs : BROWSEROS_GRACE_PERIOD_MS;
      const withinGracePeriod = runElapsedMs < effectiveGracePeriod;
      if (withinGracePeriod && topicShiftDecision.topicShiftScore < 6) {
        logLlm("BrowserOS deep dive: skipping cancellation — within grace period.", {
          newQuery: suggestion.query,
          runElapsedMs,
          gracePeriodMs: effectiveGracePeriod,
          isDirectCommand,
          directCommand: isDirectCommand ? inFlightDirectCommandRef.current : null,
          topicShiftScore: topicShiftDecision.topicShiftScore,
        });
        // Merge new tokens so they don't re-trigger on the next chunk
        lastSuggestionTranscriptRef.current = transcriptPayload;
        lastSuggestionTranscriptLineCountRef.current = transcriptLines.length;
        lastSuggestionInfoTokensRef.current = mergeTokenSets(
          lastSuggestionInfoTokensRef.current,
          newInfoTokens
        );
        lastSuggestionNumericTokensRef.current = mergeTokenSets(
          lastSuggestionNumericTokensRef.current,
          newNumericTokens
        );
        return;
      }
      logLlm("BrowserOS deep dive: cancelling in-flight run for topic shift.", {
        newQuery: suggestion.query,
        runElapsedMs,
        withinGracePeriod,
        topicShiftScore: topicShiftDecision.topicShiftScore,
      });
      browserosRunCancelledRef.current = true;
      pendingBrowserOSReplayRef.current = false;
      try { await invoke("cancel_llm_agent"); } catch { /* best-effort */ }
      await awaitWithTimeout(browserosRunPromiseRef.current, 5000);
      browserosInFlightRef.current = false;
      browserosRunCancelledRef.current = false;
      inFlightDirectCommandRef.current = "";
      setSuggestionsLoadingState(false);
      // Reset context to avoid contamination from old topic
      setActiveTopic(null);
      activeTaskTypeRef.current = null;
      lastSuggestionInfoTokensRef.current = new Set<string>();
      lastSuggestionNumericTokensRef.current = new Set<string>();
      lastIntentPlanCacheRef.current = null;
      browserWindowOpenedRef.current = false;
      // Debounce restart: schedule through debounce instead of restarting inline.
      // Use ref + timer to avoid circular dependency with scheduleBrowserOSDeepDive.
      if (browserosDeepDiveTimerRef.current) {
        window.clearTimeout(browserosDeepDiveTimerRef.current);
      }
      const restartDelayMs =
        loadOpenRouterSettings().evaluationDelayMs ?? DEFAULT_EVALUATION_DELAY_MS;
      browserosDeepDiveTimerRef.current = window.setTimeout(() => {
        browserosDeepDiveTimerRef.current = null;
        runBrowserOSDeepDiveRef.current();
      }, restartDelayMs);
      return;
    }
    const started = runBrowserOSFollowUp(suggestion, transcriptPayload, narrative, {
      trigger: {
        reason: "topic-shift",
        utterance: triggerUtterance,
        utteranceIndex: triggerUtteranceIndex,
      },
      latestSpeech: newTranscriptPayload,
    });
    if (!started) {
      logLlm("BrowserOS deep dive skipped: unable to start BrowserOS run.", {
        query: suggestion.query,
        suggestionType: suggestion.type,
      });
      return;
    }

    hasTriggeredDeepDiveRef.current = true;
    lastSuggestionTranscriptRef.current = transcriptPayload;
    lastSuggestionTranscriptLineCountRef.current = transcriptLines.length;
    lastSuggestionInfoTokensRef.current = extractInformativeTokens(transcriptPayload);
    lastSuggestionNumericTokensRef.current = extractNumericTokens(transcriptPayload);
  }, [
    activeTopic,
    buildDeepDiveNarrative,
    buildDeepDiveSuggestion,
    buildTranscriptPayload,
    detectTopicShiftWithLLM,
    logLlm,
    openSuggestionUrl,
    recordChapter,
    refineChapterTitle,
    runBrowserOSFollowUp,
    setActiveTopic,
    setSuggestionsLoadingState,
  ]);

  React.useEffect(() => {
    runBrowserOSDeepDiveRef.current = () => {
      void runBrowserOSDeepDive();
    };
  }, [runBrowserOSDeepDive]);

  const scheduleBrowserOSDeepDive = React.useCallback(() => {
    if (browserosDeepDiveTimerRef.current) {
      window.clearTimeout(browserosDeepDiveTimerRef.current);
    }
    const delayMs =
      loadOpenRouterSettings().evaluationDelayMs ?? DEFAULT_EVALUATION_DELAY_MS;
    browserosDeepDiveTimerRef.current = window.setTimeout(() => {
      browserosDeepDiveTimerRef.current = null;
      void runBrowserOSDeepDive();
    }, delayMs);
  }, [runBrowserOSDeepDive]);

  const cancelLlmSuggestions = React.useCallback(async () => {
    if (browserosDeepDiveTimerRef.current) {
      window.clearTimeout(browserosDeepDiveTimerRef.current);
      browserosDeepDiveTimerRef.current = null;
    }
    browserosRunCancelledRef.current = true;
    pendingBrowserOSReplayRef.current = false;
    browserWindowOpenedRef.current = false;
    try {
      await invoke("cancel_llm_agent");
    } catch (error) {
      log("Failed to cancel running agent task.", error);
    }
    await awaitWithTimeout(browserosRunPromiseRef.current, 5000);
    browserosInFlightRef.current = false;
    browserosRunCancelledRef.current = false;
    setSuggestionsLoadingState(false);
  }, [log, setSuggestionsLoadingState]);

  const handleTranscriptChunk = React.useCallback(
    (text: string) => {
      addTranscript(text);
      const settings = loadOpenRouterSettings();
      if (hasOpenRouterKey(settings)) {
        scheduleBrowserOSDeepDive();
      }
    },
    [addTranscript, scheduleBrowserOSDeepDive]
  );

  React.useEffect(() => {
    handleTranscriptChunkRef.current = handleTranscriptChunk;
  }, [handleTranscriptChunk]);

  const queueSegment = React.useCallback(
    (buffer: Float32Array, sampleRate: number) => {
      const downsampled = downsampleBuffer(buffer, sampleRate, OUTPUT_SAMPLE_RATE);
      const wavBytes = encodeWav(downsampled, OUTPUT_SAMPLE_RATE);
      log("Queued audio segment.", {
        inputSampleRate: sampleRate,
        outputSampleRate: OUTPUT_SAMPLE_RATE,
        samples: downsampled.length,
        wavBytes: wavBytes.length,
      });
      pendingQueueRef.current.push(wavBytes);
      void drainQueue();
    },
    [log]
  );

  const flushBuffer = React.useCallback(() => {
    if (!audioContextRef.current) return;
    const minSamples = audioContextRef.current.sampleRate * MIN_SEGMENT_SECONDS;
    if (bufferLengthRef.current < minSamples) return;

    const merged = mergeBuffers(bufferChunksRef.current, bufferLengthRef.current);
    const rms = calculateRms(merged);
    log("Segment RMS", rms.toFixed(4));
    bufferChunksRef.current = [];
    bufferLengthRef.current = 0;

    if (rms < MIN_SEGMENT_RMS_FOR_TRANSCRIPTION) {
      skippedQuietSegmentsRef.current += 1;
      if (
        skippedQuietSegmentsRef.current <= 3 ||
        skippedQuietSegmentsRef.current % 10 === 0
      ) {
        log("Skipping low-energy segment before transcription.", {
          rms: Number(rms.toFixed(4)),
          threshold: MIN_SEGMENT_RMS_FOR_TRANSCRIPTION,
          skippedSegments: skippedQuietSegmentsRef.current,
        });
      }
      return;
    }

    skippedQuietSegmentsRef.current = 0;

    queueSegment(merged, audioContextRef.current.sampleRate);
  }, [log, queueSegment]);

  const startAudioPipeline = React.useCallback(() => {
    if (!audioStreamRef.current) return;
    audioContextRef.current = new AudioContext();
    log("Audio context created.", {
      sampleRate: audioContextRef.current.sampleRate,
    });
    const source = audioContextRef.current.createMediaStreamSource(
      audioStreamRef.current
    );
    analyserRef.current = audioContextRef.current.createAnalyser();
    analyserRef.current.fftSize = 512;

    processorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);
    processorRef.current.onaudioprocess = (event) => {
      if (!isListeningRef.current) return;
      const input = event.inputBuffer.getChannelData(0);
      bufferChunksRef.current.push(new Float32Array(input));
      bufferLengthRef.current += input.length;

      const targetSamples = audioContextRef.current?.sampleRate
        ? audioContextRef.current.sampleRate * SEGMENT_SECONDS
        : 0;

      if (targetSamples && bufferLengthRef.current >= targetSamples) {
        log("Segment ready for transcription.", {
          bufferedSeconds: bufferLengthRef.current / audioContextRef.current!.sampleRate,
        });
        flushBuffer();
      }
    };

    silenceNodeRef.current = audioContextRef.current.createGain();
    silenceNodeRef.current.gain.value = 0;

    source.connect(analyserRef.current);
    source.connect(processorRef.current);
    processorRef.current.connect(silenceNodeRef.current);
    silenceNodeRef.current.connect(audioContextRef.current.destination);
  }, [flushBuffer, log]);

  const startAudioMeter = React.useCallback(() => {
    if (!audioStreamRef.current || !audioContextRef.current || !analyserRef.current) {
      return;
    }
    const data = new Uint8Array(analyserRef.current.frequencyBinCount);

    const tick = () => {
      if (!analyserRef.current || !meterRef.current) return;
      analyserRef.current.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const normalized = (data[i] - 128) / 128;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / data.length);
      const level = Math.min(100, Math.max(5, rms * 220));
      meterRef.current.style.setProperty("--meter-level", `${level}%`);
      meterFrameRef.current = requestAnimationFrame(tick);
    };

    tick();
  }, []);

  const drainQueue = React.useCallback(async () => {
    if (isTranscribingRef.current || pendingQueueRef.current.length === 0) return;
    isTranscribingRef.current = true;
    const wavBytes = pendingQueueRef.current.shift();
    if (!wavBytes) {
      isTranscribingRef.current = false;
      return;
    }

    if (isListeningRef.current) {
      setStatusState("Listening", "Transcribing segment...", true);
    }

    try {
      const audioBase64 = toBase64(wavBytes);
      log("Calling transcribe_audio.", {
        payloadBytes: wavBytes.length,
      });
      const text = await invoke<string>("transcribe_audio", { audioBase64 });
      log("Transcription response.", { text });
      if (text && text.trim()) {
        handleTranscriptChunk(text);
      }
      hadTranscriptionErrorRef.current = false;
    } catch (error) {
      log("Transcription failed.", error);
      hadTranscriptionErrorRef.current = true;
      setStatusState(
        "Listening (audio only)",
        `Transcription failed: ${String(error)}`,
        true
      );
    } finally {
      isTranscribingRef.current = false;
      if (isListeningRef.current && !hadTranscriptionErrorRef.current) {
        setStatusState("Listening", "Mic is live. Transcribing with whisper.cpp.", true);
      }
      void drainQueue();
    }
  }, [handleTranscriptChunk, isListening, log, setStatusState]);

  const stopListening = React.useCallback(async () => {
    if (!isListeningRef.current) return;
    setIsListening(false);
    isListeningRef.current = false;
    setStatusState("Not listening", "Session paused.", false);
    log("Stopping microphone stream.");

    flushBuffer();
    void cancelLlmSuggestions();

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }

    if (silenceNodeRef.current) {
      silenceNodeRef.current.disconnect();
      silenceNodeRef.current = null;
    }

    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((track) => track.stop());
      audioStreamRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    analyserRef.current = null;
    if (meterFrameRef.current) {
      cancelAnimationFrame(meterFrameRef.current);
      meterFrameRef.current = null;
    }

    skippedQuietSegmentsRef.current = 0;
    setInterimText("");
    if (meterRef.current) meterRef.current.style.setProperty("--meter-level", "0%");
  }, [cancelLlmSuggestions, flushBuffer, log, setStatusState]);

  const startListening = React.useCallback(async () => {
    if (!whisperReady) {
      setStatusState(
        "Transcription unavailable",
        "Install whisper.cpp to enable local transcription.",
        false
      );
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatusState(
        "Microphone unavailable",
        "Audio capture is not supported in this webview.",
        false
      );
      return;
    }
    if (isListeningRef.current) return;
    try {
      audioStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      log("Microphone stream started.");
    } catch {
      setStatusState(
        "Microphone blocked",
        "Grant microphone permissions in system settings.",
        false
      );
      return;
    }

    ensureSessionStart(Date.now());
    setIsListening(true);
    isListeningRef.current = true;
    setStatusState("Listening", "Mic is live. Transcribing with whisper.cpp.", true);
    startAudioPipeline();
    startAudioMeter();
  }, [
    ensureSessionStart,
    log,
    setStatusState,
    startAudioMeter,
    startAudioPipeline,
    whisperReady,
  ]);

  const clearSession = React.useCallback(() => {
    stopMockPlayback();
    stopDevPlayback();
    setDevPlaybackState("idle");
    devPlaybackNextLineRef.current = 0;
    setDevPlaybackProgress({ current: 0, total: 0 });
    setTranscripts([]);
    setInterimText("");
    setActiveTopic(null);
    setChapters([]);
    chaptersRef.current = [];
    sessionStartMsRef.current = null;
    setSessionStartMs(null);
    pendingQueueRef.current = [];
    bufferChunksRef.current = [];
    bufferLengthRef.current = 0;
    skippedQuietSegmentsRef.current = 0;
    lastSuggestionTranscriptRef.current = "";
    lastSuggestionTranscriptLineCountRef.current = 0;
    lastSuggestionInfoTokensRef.current = new Set<string>();
    lastSuggestionNumericTokensRef.current = new Set<string>();
    lastChapterTranscriptRef.current = "";
    lastChapterTranscriptLineCountRef.current = 0;
    lastChapterInfoTokensRef.current = new Set<string>();
    lastChapterNumericTokensRef.current = new Set<string>();
    hasTriggeredDeepDiveRef.current = false;
    activeTaskTypeRef.current = null;
    void cancelLlmSuggestions();
    setSuggestionsNarrative("");
    setSuggestionsLog([]);
    setSuggestionsLoadingState(false);
    lastHeyJamieCommandKeyRef.current = "";
    inFlightDirectCommandRef.current = "";
    lastBrowserOSTaskRef.current = "";
    lastBrowserOSPageUrlRef.current = "";
    browserosRunCountRef.current = 0;
    pendingBrowserOSReplayRef.current = false;
    lastDeepDiveCompletedAtRef.current = 0;
    log("Session cleared.");
  }, [
    cancelLlmSuggestions,
    log,
    setSuggestionsLoadingState,
    stopDevPlayback,
    stopMockPlayback,
  ]);

  const restartDevPlayback = React.useCallback(() => {
    stopDevPlayback();
    clearSession();
    window.setTimeout(() => {
      startDevPlayback(0);
    }, 100);
  }, [clearSession, startDevPlayback, stopDevPlayback]);

  const refreshWhisperStatus = React.useCallback(async () => {
    if (mockTranscriptMode) {
      setWhisperReady(true);
      updateSpeechTag(true);
      setSpeechModelTag("Model: mock");
      setShowSetupCard(false);
      if (!isListening) {
        if (mockTranscript) {
          setStatusState(
            "Mock transcript mode",
            `Using "${mockTranscript.id}" from src/mock-transcripts.`,
            false
          );
        } else if (mockTranscriptSelection) {
          setStatusState(
            "Mock transcript missing",
            `No mock transcript named "${mockTranscriptSelection}".`,
            false
          );
        }
      }
      return;
    }

    try {
      const statusResponse = await invoke<WhisperStatus>("check_whisper");
      const ready = Boolean(statusResponse.cliFound && statusResponse.modelFound);
      setWhisperReady(ready);
      updateSpeechTag(ready);
      setSpeechModelTag(formatWhisperModelTag(statusResponse.modelPath));
      setShowSetupCard(!ready);
      if (!ready) {
        setStatusState(
          "Transcription unavailable",
          "Install whisper.cpp to enable local transcription.",
          false
        );
      } else if (!isListening) {
        setStatusState("Not listening", "Ready when you are.", false);
      }
    } catch (error) {
      setWhisperReady(false);
      updateSpeechTag(false);
      setSpeechModelTag("Model: unavailable");
      setShowSetupCard(true);
      setStatusState(
        "Transcription unavailable",
        `Failed to check whisper status: ${String(error)}`,
        false
      );
      log("Failed to check whisper status", error);
    }
  }, [
    isListening,
    log,
    mockTranscript,
    mockTranscriptMode,
    mockTranscriptSelection,
    setStatusState,
    updateSpeechTag,
  ]);

  const runWhisperSetup = React.useCallback(async () => {
    setShowSetupCard(true);
    setSetupStatus("Installing whisper.cpp... this may take a few minutes.");
    setStatusState("Setting up", "Building whisper.cpp locally.", false);

    try {
      const output = await invoke<string>("setup_whisper");
      log("whisper.cpp setup output", output);
      setSetupStatus("Install complete. Checking status...");
    } catch (error) {
      log("whisper.cpp setup failed", error);
      setSetupStatus(`Install failed: ${String(error)}`);
    } finally {
      await refreshWhisperStatus();
    }
  }, [log, refreshWhisperStatus, setStatusState]);

  const refreshExcalidrawStatus = React.useCallback(async () => {
    try {
      const statusResponse = await invoke<ExcalidrawStatus>("check_excalidraw");
      const ready = Boolean(
        statusResponse.dirFound &&
          statusResponse.indexJsFound &&
          statusResponse.serverJsFound
      );
      setExcalidrawReady(ready);
      setShowExcalidrawSetupCard(!ready);
    } catch (error) {
      setExcalidrawReady(false);
      setShowExcalidrawSetupCard(true);
      log("Failed to check excalidraw status", error);
    }
  }, [log]);

  const runExcalidrawSetup = React.useCallback(async () => {
    setShowExcalidrawSetupCard(true);
    setExcalidrawSetupStatus("Installing mcp_excalidraw... this may take a few minutes.");

    try {
      const output = await invoke<string>("setup_excalidraw");
      log("mcp_excalidraw setup output", output);
      setExcalidrawSetupStatus("Install complete. Checking status...");
    } catch (error) {
      log("mcp_excalidraw setup failed", error);
      setExcalidrawSetupStatus(`Install failed: ${String(error)}`);
    } finally {
      await refreshExcalidrawStatus();
    }
  }, [log, refreshExcalidrawStatus]);

  const syncDevModeState = React.useCallback(() => {
    const settings = loadOpenRouterSettings();
    setDevModeEnabled(settings.developerMode);
    devPlaybackDelayMsRef.current = settings.devTranscriptDelayMs;
    const transcript = localStorage.getItem("heyjamie.devTranscript");
    setDevTranscriptAvailable(Boolean(transcript));
    setDevTranscriptName(
      localStorage.getItem("heyjamie.devTranscriptName") ?? ""
    );
    void invoke("set_dev_settings_menu_visible", { visible: settings.developerMode });
  }, []);

  const hydrateQuickSettingsFromStorage = React.useCallback(() => {
    const settings = loadOpenRouterSettings();
    setQuickTopicShiftSensitivity(
      Number.isFinite(settings.topicShiftSensitivity)
        ? settings.topicShiftSensitivity
        : DEFAULT_TOPIC_SHIFT_SENSITIVITY
    );
    setQuickEvaluationDelayMs(
      Number.isFinite(settings.evaluationDelayMs)
        ? settings.evaluationDelayMs
        : DEFAULT_EVALUATION_DELAY_MS
    );
    setQuickPersona(settings.persona || NO_PERSONA_ID);
  }, []);

  const applyQuickMcpConfigContent = React.useCallback((content: string) => {
    setQuickMcpConfigRaw(content);
    const parsed = parseMcpConfig(content);
    if (!parsed.config || parsed.error) {
      setQuickMcpConfig(null);
      setQuickMcpServers([]);
      setQuickMcpError(`Invalid MCP config: ${parsed.error ?? "Unknown error"}`);
      return false;
    }
    setQuickMcpConfig(parsed.config);
    setQuickMcpServers(summarizeMcpServers(parsed.config));
    setQuickMcpError("");
    return true;
  }, []);

  const loadQuickMcpConfig = React.useCallback(async () => {
    setQuickMcpLoading(true);
    setQuickMcpStatus("Loading MCP servers...");
    setQuickMcpError("");
    try {
      const response = await invoke<McpConfigResponse>("get_mcp_config");
      const loaded = applyQuickMcpConfigContent(response.content || "");
      setQuickMcpStatus(
        loaded
          ? `Loaded MCP config from ${response.path}.`
          : "Loaded MCP config, but it contains invalid JSON."
      );
    } catch (error) {
      setQuickMcpStatus("Failed to load MCP config.");
      setQuickMcpError(String(error));
      setQuickMcpConfig(null);
      setQuickMcpServers([]);
      setQuickMcpConfigRaw("");
    } finally {
      setQuickMcpLoading(false);
    }
  }, [applyQuickMcpConfigContent]);

  React.useEffect(() => {
    updateLlmTag();
    updateSpeechTag(whisperReady);
    void refreshWhisperStatus();
    void refreshExcalidrawStatus();
    syncDevModeState();
    hydrateQuickSettingsFromStorage();
    void loadQuickMcpConfig();

    const handleStorage = () => {
      updateLlmTag();
      syncDevModeState();
      hydrateQuickSettingsFromStorage();
    };

    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, [
    hydrateQuickSettingsFromStorage,
    loadQuickMcpConfig,
    refreshExcalidrawStatus,
    refreshWhisperStatus,
    syncDevModeState,
    updateLlmTag,
    updateSpeechTag,
    whisperReady,
  ]);

  React.useEffect(() => {
    const handleFocus = () => {
      hydrateQuickSettingsFromStorage();
      void loadQuickMcpConfig();
    };
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [hydrateQuickSettingsFromStorage, loadQuickMcpConfig]);

  React.useEffect(() => {
    if (!mockTranscriptSelection || mockTranscript) return;
    log("Mock transcript not found.", {
      selected: mockTranscriptSelection,
      available: availableMockTranscriptIds,
    });
  }, [
    availableMockTranscriptIds,
    log,
    mockTranscript,
    mockTranscriptSelection,
  ]);

  React.useEffect(() => {
    if (!mockTranscript) return;
    let didStartPlayback = false;
    if (mockPlaybackStartTimerRef.current) {
      window.clearTimeout(mockPlaybackStartTimerRef.current);
      mockPlaybackStartTimerRef.current = null;
    }

    mockPlaybackStartTimerRef.current = window.setTimeout(() => {
      mockPlaybackStartTimerRef.current = null;
      didStartPlayback = true;

      if (lastMockTranscriptIdRef.current !== mockTranscript.id) {
        hasPlayedMockTranscriptRef.current = false;
        lastMockTranscriptIdRef.current = mockTranscript.id;
      }
      if (hasPlayedMockTranscriptRef.current) return;
      hasPlayedMockTranscriptRef.current = true;
      mockPlaybackCompletedRef.current = false;
      mockPlaybackActiveRef.current = true;
      stopMockPlayback();

      const lines = splitMockTranscript(mockTranscript.text);
      if (lines.length === 0) {
        setStatusState(
          "Mock transcript mode",
          `Mock transcript "${mockTranscript.id}" is empty.`,
          false
        );
        mockPlaybackCompletedRef.current = true;
        mockPlaybackActiveRef.current = false;
        maybeFinalizeIntegrationTestRun();
        return;
      }

      const settings = loadOpenRouterSettings();
      const hasLlmKey = hasOpenRouterKey(settings);
      const playableLineCount = lines.filter(
        (line) => !mockPlaybackSleepPattern.test(line)
      ).length;

      if (!hasLlmKey) {
        log(
          "Mock transcript mode is running without OpenRouter key. Browser deep dives will not run."
        );
        setStatusState(
          "Mock transcript mode",
          `Running "${mockTranscript.id}" without OpenRouter key (browser automation disabled).`,
          false
        );
      }

      log("Running mock transcript.", {
        id: mockTranscript.id,
        lineCount: playableLineCount,
        markerCount: lines.length - playableLineCount,
      });
      logLlm("Mock transcript playback started.", {
        id: mockTranscript.id,
        lineCount: playableLineCount,
        markerCount: lines.length - playableLineCount,
        hasOpenRouterKeyForBrowserOS: hasLlmKey,
      });
      resetTestLogForRun({
        transcriptId: mockTranscript.id,
        playableLineCount,
        markerCount: lines.length - playableLineCount,
      });
      setStatusState(
        "Mock transcript mode",
        `Running "${mockTranscript.id}" (${playableLineCount} lines).`,
        false
      );
      if (playableLineCount === 0) {
        setStatusState(
          "Mock transcript mode",
          `Mock transcript "${mockTranscript.id}" has no playable lines.`,
          false
        );
        logLlm("Mock transcript has no playable lines.", {
          id: mockTranscript.id,
        });
        mockPlaybackCompletedRef.current = true;
        mockPlaybackActiveRef.current = false;
        maybeFinalizeIntegrationTestRun();
        return;
      }

      let playbackOffsetMs = 0;
      let emittedPlayableLines = 0;
      lines.forEach((line) => {
        const sleepMatch = line.match(mockPlaybackSleepPattern);
        if (sleepMatch) {
          const rawSleepMs = Number.parseInt(sleepMatch[1] ?? "", 10);
          const sleepMs =
            Number.isFinite(rawSleepMs) && rawSleepMs > 0 ? rawSleepMs : 0;
          if (sleepMs > 0) {
            playbackOffsetMs += sleepMs;
            logLlm("Mock transcript sleep marker.", {
              id: mockTranscript.id,
              sleepMs,
              nextOffsetMs: playbackOffsetMs,
            });
            appendTestLogEvent({
              event: "sleep-marker",
              transcriptId: mockTranscript.id,
              sleepMs,
              nextOffsetMs: playbackOffsetMs,
            });
          }
          return;
        }

        const lineNumber = emittedPlayableLines;
        emittedPlayableLines += 1;
        const isLastPlayableLine = lineNumber === playableLineCount - 1;
        const timerId = window.setTimeout(() => {
          appendTestLogEvent({
            event: "utterance",
            transcriptId: mockTranscript.id,
            utteranceIndex: lineNumber + 1,
            text: line,
          });
          handleTranscriptChunkRef.current(line);
          if (isLastPlayableLine) {
            if (!hasLlmKey) {
              logLlm(
                "Mock transcript completed without OpenRouter key; skipping browser deep dive.",
                {
                  id: mockTranscript.id,
                }
              );
            }
            setStatusState(
              "Mock transcript mode",
              `Completed "${mockTranscript.id}".`,
              false
            );
            logLlm("Mock transcript playback completed.", {
              id: mockTranscript.id,
            });
            appendTestLogEvent({
              event: "playback-complete",
              transcriptId: mockTranscript.id,
              hadOpenRouterKey: hasLlmKey,
            });
            mockPlaybackCompletedRef.current = true;
            mockPlaybackActiveRef.current = false;
            maybeFinalizeIntegrationTestRun();
          }
        }, playbackOffsetMs);
        mockPlaybackTimersRef.current.push(timerId);
        playbackOffsetMs += MOCK_PLAYBACK_LINE_DELAY_MS;
      });
    }, 0);

    return () => {
      if (mockPlaybackStartTimerRef.current) {
        window.clearTimeout(mockPlaybackStartTimerRef.current);
        mockPlaybackStartTimerRef.current = null;
      }
      if (!didStartPlayback) return;
      stopMockPlayback();
      mockPlaybackActiveRef.current = false;
      if (!mockPlaybackCompletedRef.current) {
        hasPlayedMockTranscriptRef.current = false;
      }
    };
  }, [
    appendTestLogEvent,
    log,
    logLlm,
    maybeFinalizeIntegrationTestRun,
    mockTranscript,
    resetTestLogForRun,
    setStatusState,
    stopMockPlayback,
  ]);

  const toggleListen = React.useCallback(() => {
    if (isListening) {
      void stopListening();
      return;
    }
    void startListening();
  }, [isListening, startListening, stopListening]);

  const transcriptLines = transcripts.slice(-12).map((entry) => entry.text);

  React.useEffect(() => {
    const el = transcriptScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [transcriptLines.length, interimText]);

  React.useEffect(() => {
    const el = narrativeScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [suggestionsNarrative, suggestionsLog.length, suggestionsLoading]);

  const isListeningDisabled = !whisperReady;
  const statusIndicator = React.useMemo(() => {
    const text = status.text.toLowerCase();
    const meta = status.meta.toLowerCase();

    if (status.live) {
      return {
        icon: Mic,
        ringClassName: "border-emerald-500/40 bg-emerald-500/10",
        iconClassName: "text-emerald-400",
        title: `${status.text}. ${status.meta}`,
      };
    }

    if (text.includes("setting up")) {
      return {
        icon: Loader2,
        ringClassName: "border-amber-500/40 bg-amber-500/10",
        iconClassName: "animate-spin text-amber-400",
        title: `${status.text}. ${status.meta}`,
      };
    }

    if (
      text.includes("unavailable") ||
      text.includes("blocked") ||
      text.includes("failed") ||
      meta.includes("failed")
    ) {
      return {
        icon: AlertTriangle,
        ringClassName: "border-destructive/40 bg-destructive/10",
        iconClassName: "text-destructive",
        title: `${status.text}. ${status.meta}`,
      };
    }

    return {
      icon: MicOff,
      ringClassName: "border-border/70 bg-muted/50",
      iconClassName: "text-muted-foreground",
      title: `${status.text}. ${status.meta}`,
    };
  }, [status]);
  const StatusIcon = statusIndicator.icon;
  const currentChapter = chapters.length > 0 ? chapters[chapters.length - 1] : null;
  const chapterNotes = React.useMemo(() => {
    if (chapters.length === 0) return "";
    return chapters
      .map((chapter) => {
        const line = `${formatElapsedTimestamp(chapter.timestampMs)} ${chapter.title}`;
        if (chapter.urls.length === 0) return line;
        return [line, ...chapter.urls].join("\n");
      })
      .join("\n\n");
  }, [chapters]);
  const topicShiftBadgeLabel = React.useMemo(() => {
    const level = TOPIC_SHIFT_SENSITIVITY_LEVELS.find(
      (entry) => entry.value === quickTopicShiftSensitivity
    );
    return `Sensitivity: ${level?.label ?? quickTopicShiftSensitivity}`;
  }, [quickTopicShiftSensitivity]);
  const evaluationDelayBadgeLabel = React.useMemo(() => {
    const level = EVALUATION_DELAY_LEVELS.find(
      (entry) => entry.value === quickEvaluationDelayMs
    );
    return `Eval: ${level?.label ?? `${quickEvaluationDelayMs}ms`}`;
  }, [quickEvaluationDelayMs]);
  const personaBadgeLabel = React.useMemo(() => {
    const personaName =
      PERSONAS.find((persona) => persona.id === quickPersona)?.name ?? "None";
    return `Persona: ${personaName}`;
  }, [quickPersona]);
  const mcpServersBadgeLabel = React.useMemo(() => {
    if (quickMcpLoading && quickMcpServers.length === 0) {
      return "MCP: loading...";
    }
    if (quickMcpError && quickMcpServers.length === 0) {
      return "MCP: unavailable";
    }
    if (quickMcpServers.length === 0) {
      return "MCP: none";
    }
    const labels = quickMcpServers.map((server) =>
      server.enabled ? server.name : `${server.name} (off)`
    );
    return `MCP: ${truncateText(labels.join(", "), 84)}`;
  }, [quickMcpError, quickMcpLoading, quickMcpServers]);

  return (
    <div className="h-dvh overflow-hidden bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-3 overflow-hidden px-6 pt-3 pb-6">
        <header className="flex flex-none flex-col gap-4">
          <div className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-2 py-1 shadow-sm">
            <Badge variant="outline" className="text-[11px] uppercase tracking-[0.2em]">
              {whisperReady ? "MIC READY" : "MIC OFFLINE"}
            </Badge>
            <Badge variant="outline" className="text-[11px]">
              {speechTag}
            </Badge>
            <Badge variant="outline" className="text-[11px]">
              {speechModelTag}
            </Badge>
            <Badge variant="outline" className="text-[11px]">
              {llmTag}
            </Badge>
            <Badge variant="outline" className="text-[11px]">
              {topicShiftBadgeLabel}
            </Badge>
            <Badge variant="outline" className="text-[11px]">
              {evaluationDelayBadgeLabel}
            </Badge>
            <Badge variant="outline" className="text-[11px]">
              {personaBadgeLabel}
            </Badge>
            <Badge variant="outline" className="max-w-[30rem] text-[11px]" title={mcpServersBadgeLabel}>
              {mcpServersBadgeLabel}
            </Badge>
          </div>
        </header>

        {showSetupCard && (
          <Card className="flex-none border-dashed border-primary/40 bg-muted/30">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base">Whisper Setup</CardTitle>
                <CardDescription>
                  whisper.cpp is not installed yet. Install it to enable local transcription.
                </CardDescription>
              </div>
              <Button onClick={runWhisperSetup} size="sm" className="gap-2">
                <Mic className="h-3.5 w-3.5" />
                Install
              </Button>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">{setupStatus}</p>
            </CardContent>
          </Card>
        )}

        {showExcalidrawSetupCard && (
          <Card className="flex-none border-dashed border-primary/40 bg-muted/30">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base">Excalidraw Setup</CardTitle>
                <CardDescription>
                  mcp_excalidraw is not installed yet. Install it to enable diagram creation.
                </CardDescription>
              </div>
              <Button onClick={runExcalidrawSetup} size="sm" className="gap-2">
                <PenTool className="h-3.5 w-3.5" />
                Install
              </Button>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">{excalidrawSetupStatus}</p>
            </CardContent>
          </Card>
        )}

        <div
          className={cn(
            "grid min-h-0 flex-1 gap-6 overflow-hidden",
            sidebarCollapsed
              ? "grid-cols-[52px_1fr]"
              : "grid-cols-[minmax(220px,280px)_1fr]"
          )}
        >
          <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-muted/30 p-3">
            <div className="flex items-center justify-between">
              {!sidebarCollapsed && (
                <span className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                  Live Feed
                </span>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              >
                {sidebarCollapsed ? (
                  <ChevronRight className="h-4 w-4" />
                ) : (
                  <ChevronLeft className="h-4 w-4" />
                )}
              </Button>
            </div>
            {!sidebarCollapsed && (
              <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3">
                <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-border/60 bg-background/60">
                  <div className="border-b border-border/60 px-3 py-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      Transcript
                    </span>
                  </div>
                  <div ref={transcriptScrollRef} className="flex-1 space-y-3 overflow-y-auto p-3 pr-2 text-sm text-foreground scrollbar-hidden">
                    {transcriptLines.length === 0 && !interimText && (
                      <p className="text-muted-foreground">No transcript yet.</p>
                    )}
                    {transcriptLines.map((line, index) => (
                      <p key={`${line}-${index}`} className="leading-relaxed">
                        {line}
                      </p>
                    ))}
                    {interimText && (
                      <p className="text-muted-foreground">{interimText}</p>
                    )}
                  </div>
                </section>

                <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-border/60 bg-background/60">
                  <div className="border-b border-border/60 px-3 py-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      Active Deep Dive
                    </span>
                  </div>
                  <div className="flex-1 space-y-2 overflow-y-auto p-3 pr-2 scrollbar-hidden">
                    {!activeTopic && (
                      <p className="text-sm text-muted-foreground">
                        Waiting for a topic shift to launch browser automation.
                      </p>
                    )}
                    {activeTopic && (
                      <div className="rounded-md border border-border/60 bg-muted/20 p-2">
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="secondary"
                            className="text-[10px] uppercase tracking-[0.2em]"
                          >
                            {activeTopic.type}
                          </Badge>
                          <span className="line-clamp-1 text-xs font-semibold text-foreground">
                            {activeTopic.query}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {activeTopic.note}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-[11px]"
                            onClick={() => openSuggestionInBrowser(activeTopic)}
                          >
                            Open
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-[11px]"
                            onClick={() =>
                              navigator.clipboard.writeText(activeTopic.query)
                            }
                          >
                            Copy
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </section>

                <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-border/60 bg-background/60">
                  <div className="border-b border-border/60 px-3 py-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      Show Progress
                    </span>
                  </div>
                  <div className="flex-1 space-y-2 overflow-y-auto p-3 pr-2 text-xs text-muted-foreground scrollbar-hidden">
                    <div className="flex items-center justify-between">
                      <span>Elapsed</span>
                      <span className="font-semibold text-foreground">
                        {sessionStartMs ? formatElapsedTimestamp(elapsedMs) : "00:00"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Chapters</span>
                      <span className="font-semibold text-foreground">
                        {chapters.length}
                      </span>
                    </div>
                    <div className="space-y-1">
                      <span className="block">Current</span>
                      {currentChapter ? (
                        <span className="line-clamp-2 text-foreground">
                          {currentChapter.title}
                        </span>
                      ) : (
                        <span>No chapters yet.</span>
                      )}
                    </div>
                  </div>
                </section>

                <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-border/60 bg-background/60">
                  <div className="border-b border-border/60 px-3 py-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                      YouTube Chapters
                    </span>
                  </div>
                  <div className="flex-1 space-y-2 overflow-y-auto p-3 pr-2 text-xs text-muted-foreground scrollbar-hidden">
                    {chapterNotes ? (
                      <>
                        <pre className="whitespace-pre-wrap rounded-md border border-border/60 bg-muted/30 p-3 text-xs text-foreground/90">
                          {chapterNotes}
                        </pre>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 w-full text-[11px]"
                          onClick={() => {
                            void navigator.clipboard.writeText(chapterNotes);
                          }}
                        >
                          Copy Chapters
                        </Button>
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Chapters will appear as the transcript progresses.
                      </p>
                    )}
                  </div>
                </section>
              </div>
            )}
          </aside>

          <main className="flex min-h-0 flex-col gap-6 overflow-hidden">
            <div className="flex flex-none items-center gap-3">
              <div className="relative grid h-28 w-28 place-items-center">
                <span className="absolute inset-0 rounded-full border border-border/60 bg-muted/30" />
                <span className="pointer-events-none absolute inset-1 rounded-full border border-border/40 bg-[repeating-conic-gradient(from_-90deg,rgba(148,163,184,0.22)_0deg,rgba(148,163,184,0.22)_7deg,transparent_7deg,transparent_12deg)] [mask-image:radial-gradient(circle,transparent_60%,black_61%,black_71%,transparent_72%)]" />
                <span
                  ref={meterRef}
                  className={cn(
                    "pointer-events-none absolute inset-1 rounded-full transition-opacity",
                    isListening ? "opacity-100" : "opacity-55"
                  )}
                  style={
                    {
                      "--meter-level": "0%",
                      background:
                        "conic-gradient(from -90deg, rgba(16,185,129,0.95) var(--meter-level), rgba(148,163,184,0.14) var(--meter-level))",
                      WebkitMaskImage:
                        "radial-gradient(circle, transparent 60%, black 61%, black 71%, transparent 72%)",
                      maskImage:
                        "radial-gradient(circle, transparent 60%, black 61%, black 71%, transparent 72%)",
                    } as React.CSSProperties
                  }
                />
                <Button
                  onClick={toggleListen}
                  disabled={isListeningDisabled}
                  variant={isListening ? "secondary" : "default"}
                  size="icon"
                  title={isListening ? "Stop listening" : "Start listening"}
                  className="relative z-10 h-14 w-14 rounded-full shadow-md"
                >
                  {isListening ? (
                    <Square className="h-4 w-4" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  <span className="sr-only">
                    {isListening ? "Stop listening" : "Start listening"}
                  </span>
                </Button>
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <span
                  className={cn(
                    "inline-flex h-9 w-9 items-center justify-center rounded-full border",
                    statusIndicator.ringClassName
                  )}
                  title={statusIndicator.title}
                >
                  <StatusIcon className={cn("h-4 w-4", statusIndicator.iconClassName)} />
                  <span className="sr-only">{statusIndicator.title}</span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={clearSession}
                  title="Clear session"
                >
                  <RefreshCw className="h-4 w-4" />
                  <span className="sr-only">Clear session</span>
                </Button>
              </div>
              {devModeEnabled && devTranscriptAvailable && !mockTranscriptMode && (
                <div className="flex flex-col items-center gap-1">
                  <div className="flex items-center gap-2">
                    {devPlaybackState === "idle" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => startDevPlayback(0)}
                      >
                        <Play className="h-3 w-3" />
                        Play
                      </Button>
                    )}
                    {devPlaybackState === "playing" && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          onClick={pauseDevPlayback}
                        >
                          <Pause className="h-3 w-3" />
                          Pause
                        </Button>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {devPlaybackProgress.current}/{devPlaybackProgress.total}
                        </span>
                      </>
                    )}
                    {devPlaybackState === "paused" && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          onClick={resumeDevPlayback}
                        >
                          <Play className="h-3 w-3" />
                          Resume
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          onClick={restartDevPlayback}
                        >
                          <RefreshCw className="h-3 w-3" />
                          Restart
                        </Button>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {devPlaybackProgress.current}/{devPlaybackProgress.total}
                        </span>
                      </>
                    )}
                  </div>
                  {devTranscriptName && (
                    <span className="max-w-[10rem] truncate text-[10px] text-muted-foreground" title={devTranscriptName}>
                      {devTranscriptName}
                    </span>
                  )}
                </div>
              )}
            </div>
            <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="h-4 w-4 text-emerald-300" />
                  Hey Jamie
                </CardTitle>
              </CardHeader>
              <CardContent ref={narrativeScrollRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-3 scrollbar-hidden">
                {suggestionsLoading.isLoading && (
                  <div className="flex items-center gap-2 rounded-full border border-border/60 px-3 py-1 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {suggestionsLoading.message}
                  </div>
                )}

                <details open className="rounded-lg border border-border/60 bg-background/60">
                  <summary className="cursor-pointer list-none px-4 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                    Narrative
                  </summary>
                  <div className="border-t border-border/60 px-4 py-4">
                    {suggestionsNarrative ? (
                      <div
                        className="text-sm leading-relaxed text-foreground/90"
                        dangerouslySetInnerHTML={{
                          __html: linkifyText(suggestionsNarrative),
                        }}
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No narrative yet.
                      </p>
                    )}
                  </div>
                </details>

                {suggestionsLog.length > 0 && (
                  <Card className="border-border/60">
                    <CardHeader className="py-4">
                      <CardTitle className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                        Session Log
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {suggestionsLog.map((entry) => (
                        <div
                          key={entry.id}
                          className="rounded-lg border border-border/60 bg-muted/30 p-3"
                        >
                          <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                            <span>{formatLogTimestamp(entry.timestamp)}</span>
                            <span>
                              {entry.toolCalls.length} tool calls · {entry.suggestions.length} topics
                            </span>
                          </div>
                          <div
                            className="mt-2 text-sm text-foreground/90"
                            dangerouslySetInnerHTML={{
                              __html: linkifyText(entry.narrative || "No narrative returned."),
                            }}
                          />
                          {entry.toolCalls.length > 0 && (
                            <div className="mt-3 space-y-2 text-xs">
                              {entry.toolCalls.map((tool) => (
                                <div
                                  key={tool.id}
                                  className="rounded-md border border-border/60 bg-background/60 p-2"
                                >
                                  <div className="flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
                                    <span>{tool.name}</span>
                                    <span>{tool.id}</span>
                                  </div>
                                  <pre className="mt-1 whitespace-pre-wrap text-[11px] text-foreground/80">
                                    {formatToolPayload(tool.input, 240)}
                                    {tool.output ? `\n\n${formatToolPayload(tool.output, 400)}` : ""}
                                  </pre>
                                </div>
                              ))}
                            </div>
                          )}
                          {entry.suggestions.length > 0 && (
                            <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                              {entry.suggestions.map((suggestion) => (
                                <div key={suggestion.id} className="flex items-center gap-2">
                                  <Badge variant="secondary" className="text-[10px] uppercase tracking-[0.2em]">
                                    {suggestion.type}
                                  </Badge>
                                  <span className="text-foreground/80">
                                    {suggestion.query}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}

              </CardContent>
            </Card>
          </main>
        </div>
      </div>
    </div>
  );
}
