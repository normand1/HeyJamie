export type OptionLevel<T extends number = number> = {
  value: T;
  label: string;
  description: string;
};

export const TOPIC_SHIFT_SENSITIVITY_LEVELS: ReadonlyArray<OptionLevel<1 | 2 | 3 | 4 | 5>> = [
  {
    value: 1,
    label: "Very sensitive",
    description: "Trigger deep dives on subtle topic movement.",
  },
  {
    value: 2,
    label: "Sensitive",
    description: "React quickly, but require a hint of novelty.",
  },
  {
    value: 3,
    label: "Balanced",
    description: "Default. Expect noticeable context shifts.",
  },
  {
    value: 4,
    label: "Cautious",
    description: "Prefer strong new intent before running browser automation.",
  },
  {
    value: 5,
    label: "Very cautious",
    description: "Only trigger on clear topic changes.",
  },
] as const;

export const EVALUATION_DELAY_LEVELS: ReadonlyArray<OptionLevel<1200 | 3000 | 5000 | 10000>> = [
  {
    value: 1200,
    label: "Fast (1.2s)",
    description: "Evaluate quickly after speech.",
  },
  {
    value: 3000,
    label: "Moderate (3s)",
    description: "Wait 3 seconds before evaluating.",
  },
  {
    value: 5000,
    label: "Slow (5s)",
    description: "Wait 5 seconds before evaluating.",
  },
  {
    value: 10000,
    label: "Very slow (10s)",
    description: "Wait 10 seconds before evaluating.",
  },
] as const;

function findLevel<T extends number>(levels: ReadonlyArray<OptionLevel<T>>, value: number): OptionLevel<T> | undefined {
  return levels.find((level) => level.value === value);
}

export function describeTopicShiftSensitivity(value: number): string {
  return findLevel(TOPIC_SHIFT_SENSITIVITY_LEVELS, value)?.description ?? "";
}

export function describeEvaluationDelay(value: number): string {
  return findLevel(EVALUATION_DELAY_LEVELS, value)?.description ?? "";
}
