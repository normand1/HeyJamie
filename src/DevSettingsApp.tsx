import * as React from "react";

import {
  DEFAULT_DEV_TRANSCRIPT_DELAY_MS,
  loadOpenRouterSettings,
  saveOpenRouterSettings,
} from "./openrouter";
import { Button } from "./components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { cn } from "./lib/utils";

export function DevSettingsApp() {
  const [delayInputValue, setDelayInputValue] = React.useState(
    String(DEFAULT_DEV_TRANSCRIPT_DELAY_MS)
  );
  const [devTranscriptName, setDevTranscriptName] = React.useState("");
  const [devTranscriptLineCount, setDevTranscriptLineCount] = React.useState(0);
  const [devTranscriptDropActive, setDevTranscriptDropActive] = React.useState(false);
  const devTranscriptFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [saveStatus, setSaveStatus] = React.useState("");

  const hydrateForm = React.useCallback(() => {
    const settings = loadOpenRouterSettings();
    setDelayInputValue(
      String(
        Number.isFinite(settings.devTranscriptDelayMs)
          ? settings.devTranscriptDelayMs
          : DEFAULT_DEV_TRANSCRIPT_DELAY_MS
      )
    );

    const storedTranscript = localStorage.getItem("heyjamie.devTranscript");
    const storedName = localStorage.getItem("heyjamie.devTranscriptName");
    if (storedTranscript && storedName) {
      setDevTranscriptName(storedName);
      setDevTranscriptLineCount(
        storedTranscript.split(/\r?\n/).filter((l) => l.trim()).length
      );
    } else {
      setDevTranscriptName("");
      setDevTranscriptLineCount(0);
    }
  }, []);

  React.useEffect(() => {
    hydrateForm();

    const handleStorage = () => {
      hydrateForm();
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [hydrateForm]);

  const applyDevTranscriptFile = React.useCallback(async (file: File) => {
    try {
      const content = await file.text();
      localStorage.setItem("heyjamie.devTranscript", content);
      localStorage.setItem("heyjamie.devTranscriptName", file.name);
      setDevTranscriptName(file.name);
      setDevTranscriptLineCount(
        content.split(/\r?\n/).filter((l) => l.trim()).length
      );
      setSaveStatus(`Loaded transcript "${file.name}".`);
    } catch (error) {
      setSaveStatus(`Failed to read transcript file: ${String(error)}`);
    } finally {
      if (devTranscriptFileInputRef.current) {
        devTranscriptFileInputRef.current.value = "";
      }
    }
  }, []);

  const clearDevTranscript = React.useCallback(() => {
    localStorage.removeItem("heyjamie.devTranscript");
    localStorage.removeItem("heyjamie.devTranscriptName");
    setDevTranscriptName("");
    setDevTranscriptLineCount(0);
    setSaveStatus("Dev transcript removed.");
  }, []);

  const clampDelay = React.useCallback((raw: string) => {
    const val = Number(raw);
    if (!Number.isFinite(val) || val < 50) return 50;
    if (val > 10000) return 10000;
    return Math.round(val);
  }, []);

  const handleSave = React.useCallback(() => {
    const clamped = clampDelay(delayInputValue);
    setDelayInputValue(String(clamped));
    const current = loadOpenRouterSettings();
    saveOpenRouterSettings({ ...current, devTranscriptDelayMs: clamped });
    setSaveStatus("Settings saved.");
  }, [clampDelay, delayInputValue]);

  return (
    <div className="h-dvh overflow-hidden bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-6 overflow-hidden px-6 py-6">
        <header>
          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
            Developer Settings
          </p>
          <h1 className="text-2xl font-semibold">Transcript Playback</h1>
          <p className="text-sm text-muted-foreground">
            Load a transcript file and play it back line-by-line in the main app.
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hidden">
          <Card>
            <CardHeader>
              <CardTitle>Developer</CardTitle>
              <CardDescription>
                Load a transcript file and play it back line-by-line in the main app.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {devTranscriptName ? (
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                  <div className="text-sm">
                    <span className="font-medium text-foreground">{devTranscriptName}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {devTranscriptLineCount} line{devTranscriptLineCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <Button variant="ghost" size="sm" onClick={clearDevTranscript}>
                    Remove
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No transcript loaded.</p>
              )}

              <div
                className={cn(
                  "rounded-lg border border-dashed border-border/70 bg-muted/20 p-4 text-center text-sm text-muted-foreground transition-colors",
                  "cursor-pointer hover:border-primary/40 hover:bg-muted/40",
                  devTranscriptDropActive && "border-primary/60 bg-primary/10 text-foreground"
                )}
                role="button"
                tabIndex={0}
                onClick={() => devTranscriptFileInputRef.current?.click()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    devTranscriptFileInputRef.current?.click();
                  }
                }}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDevTranscriptDropActive(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDevTranscriptDropActive(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  setDevTranscriptDropActive(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDevTranscriptDropActive(false);
                  const file = event.dataTransfer?.files?.[0];
                  if (file) {
                    void applyDevTranscriptFile(file);
                  }
                }}
              >
                <p className="font-medium text-foreground">Drop a transcript file here</p>
                <p className="text-xs">or click to upload a .txt file</p>
                <input
                  ref={devTranscriptFileInputRef}
                  className="hidden"
                  type="file"
                  accept=".txt,text/plain"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      void applyDevTranscriptFile(file);
                    }
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="dev-transcript-delay">Playback delay (ms)</Label>
                <Input
                  id="dev-transcript-delay"
                  type="number"
                  min={50}
                  max={10000}
                  step={50}
                  value={delayInputValue}
                  onChange={(event) => setDelayInputValue(event.target.value)}
                  onBlur={() => {
                    const clamped = clampDelay(delayInputValue);
                    setDelayInputValue(String(clamped));
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Delay between each transcript line during playback. Use{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">{"[[sleep:NNNN]]"}</code>{" "}
                  markers in the transcript file for custom pauses.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <Button onClick={handleSave}>Save</Button>
                {saveStatus && (
                  <span className="text-xs text-muted-foreground">{saveStatus}</span>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
