import type { Persona } from "./types";
import { comedian } from "./comedian";
import { factChecker } from "./factChecker";
import { debunker } from "./debunker";

export type { Persona } from "./types";

export const NO_PERSONA_ID = "";

export const PERSONAS: readonly Persona[] = [comedian, factChecker, debunker];

export function getPersonaById(id: string): Persona | undefined {
  return PERSONAS.find((p) => p.id === id);
}
