export type UserNote = {
  id: string;
  text: string;
  createdAt: number;
};

const STORAGE_KEY = "heyjamie.userNotes";

export function loadUserNotes(): UserNote[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (n: unknown): n is UserNote =>
        typeof n === "object" &&
        n !== null &&
        typeof (n as UserNote).id === "string" &&
        typeof (n as UserNote).text === "string" &&
        typeof (n as UserNote).createdAt === "number"
    );
  } catch {
    return [];
  }
}

export function saveUserNotes(notes: UserNote[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

export function addUserNote(text: string): UserNote | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const notes = loadUserNotes();
  const lowerTrimmed = trimmed.toLowerCase();
  if (notes.some((n) => n.text.trim().toLowerCase() === lowerTrimmed)) {
    return null;
  }
  const note: UserNote = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: trimmed,
    createdAt: Date.now(),
  };
  notes.push(note);
  saveUserNotes(notes);
  return note;
}

export function removeUserNote(id: string): void {
  const notes = loadUserNotes();
  saveUserNotes(notes.filter((n) => n.id !== id));
}

export function updateUserNote(id: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const notes = loadUserNotes();
  const index = notes.findIndex((n) => n.id === id);
  if (index === -1) return;
  notes[index] = { ...notes[index], text: trimmed };
  saveUserNotes(notes);
}

export function formatUserNotesForPrompt(notes: UserNote[]): string {
  if (notes.length === 0) return "";
  const bullets = notes.map((n) => `- ${n.text}`).join("\n");
  return `\n## User Notes\nThe user has saved the following preferences and instructions. Respect these in all actions:\n${bullets}`;
}
