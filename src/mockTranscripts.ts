export type MockTranscript = {
  id: string;
  path: string;
  text: string;
};

const transcriptModules = import.meta.glob("./mock-transcripts/*.txt", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const transcripts: MockTranscript[] = Object.entries(transcriptModules)
  .map(([path, text]) => {
    const parts = path.split("/");
    const file = parts[parts.length - 1] ?? "";
    const id = file.replace(/\.txt$/i, "").trim().toLowerCase();
    if (!id) return null;
    return {
      id,
      path,
      text,
    } satisfies MockTranscript;
  })
  .filter(Boolean) as MockTranscript[];

const transcriptById = new Map(
  transcripts.map((item) => [item.id, item] as const)
);

export function listMockTranscriptIds(): string[] {
  return transcripts.map((item) => item.id).sort();
}

export function getMockTranscript(id: string | null | undefined): MockTranscript | null {
  const normalized = typeof id === "string" ? id.trim().toLowerCase() : "";
  if (!normalized) return null;
  return transcriptById.get(normalized) ?? null;
}

export function splitMockTranscript(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
