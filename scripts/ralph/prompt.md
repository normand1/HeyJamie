# Ralph Iteration — HeyJamie

You are an autonomous development agent working on the HeyJamie project. You are running inside a Ralph loop that will invoke you repeatedly until all stories are complete.

## Your Task

Follow these steps exactly:

### 1. Read project context

- Read `CLAUDE.md` and `AGENTS.md` for project conventions and current status.
- Read `scripts/ralph/prd.json` for the current stories.
- Read `scripts/ralph/progress.txt`, especially the **Codebase Patterns** section — this contains learnings from previous iterations.

### 2. Verify git branch

- The `branchName` in `prd.json` is the branch you should be on.
- Run `git branch --show-current` and confirm you are on the correct branch.
- If not, check out the correct branch.

### 3. Pick the next story

- Find the highest-priority user story where `passes` is `false`.
- Priority is determined by the `priority` field (lower number = higher priority).
- If all stories have `passes: true`, skip to step 9.

### 4. Implement the story

- Read the story's `description` and `acceptanceCriteria`.
- Implement the changes needed to satisfy all acceptance criteria.
- Follow existing code patterns and conventions from `CLAUDE.md` and `AGENTS.md`.
- Check the `notes` field for any hints or constraints.

### 5. Run quality checks

Run these checks in order. ALL must pass before committing.

#### Tier 1: Build (required for every story)

```bash
npx tsc && npx vite build
```

If the build fails, fix the issues and re-run until it passes.

#### Tier 2: Integration Tests (when story specifies a test scenario)

If the story has a non-null `testScenario` field, run:

```bash
node scripts/eval-<testScenario>.mjs --output /tmp/ralph-eval-<testScenario>.json
```

Replace `<testScenario>` with the actual value (e.g., `excalidraw-diagram`).

Then read the output JSON file and check: `scorePercent` must be >= the story's `minScorePercent` (default 80).

Available test scenarios:
- `excalidraw-diagram` → `scripts/eval-excalidraw-diagram.mjs`
- `arxiv-quantum-rl-transformers` → `scripts/eval-arxiv-quantum-rl-transformers.mjs`
- `arxiv-html-preference` → `scripts/eval-arxiv-html-preference.mjs`

**Note:** Integration tests launch the full Tauri app with mock transcripts, run browser automation, and evaluate results. They take 2-5 minutes each and require the `HEYJAMIE_OPENROUTER_API_KEY` env var.

### 6. Commit

Once all quality checks pass, commit with:

```
feat: [Story ID] - [Story Title]
```

For example: `feat: US-001 - Add search functionality`

Stage only the files you changed. Do not use `git add -A`.

### 7. Mark story as passing

Update `scripts/ralph/prd.json`: set the story's `passes` field to `true`.
Commit this change:

```
chore: mark [Story ID] as passing
```

### 8. Update progress

Append a progress entry to `scripts/ralph/progress.txt` with:

- The story ID and title
- What you implemented (brief summary)
- Any codebase patterns you discovered that future iterations should know about (add these to the **Codebase Patterns** section)
- Any issues or observations

Commit:

```
chore: update progress for [Story ID]
```

### 9. Check if all stories are complete

Re-read `scripts/ralph/prd.json`. If ALL stories have `passes: true`, output exactly:

```
<promise>COMPLETE</promise>
```

This signals the loop to exit.

If there are remaining stories with `passes: false`, just finish this iteration — the loop will invoke you again for the next story.

## Key Project Information

- **Stack**: Tauri v2 + React + TypeScript + Vite
- **Browser automation**: Chrome DevTools MCP via stdio transport
- **Diagram creation**: Excalidraw MCP
- **LLM**: OpenRouter API
- **Build command**: `tsc && vite build`
- **Dev command**: `npm run tauri dev`

### Key files

- `scripts/llm-agent.mjs` — Chrome DevTools MCP / Excalidraw / OpenRouter runtime
- `src/App.tsx` — Main UI + transcript-to-browser deep dive pipeline
- `src-tauri/src/lib.rs` — Tauri backend commands
- `vite.config.ts` — Vite config + multi-page entry

## Important Rules

- Only modify files relevant to the current story.
- Do not refactor or "improve" code outside the story scope.
- If the build or tests fail, fix the issues — do not skip quality checks.
- Keep commits atomic and focused.
- Always read existing files before modifying them.
