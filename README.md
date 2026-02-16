<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->
[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![MIT License][license-shield]][license-url]

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://github.com/normand1/HeyJamie">
    <img src="images/logo.png" alt="Logo" width="200" height="200">
  </a>

<h3 align="center">HeyJamie</h3>

  <p align="center">
    A voice-driven podcast production companion that transcribes speech, detects topics, and automates browser research and diagram creation.
    <br />
    <a href="https://github.com/normand1/HeyJamie/issues/new?labels=bug&template=bug-report---.md">Report Bug</a>
    &middot;
    <a href="https://github.com/normand1/HeyJamie/issues/new?labels=enhancement&template=feature-request---.md">Request Feature</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
        <li><a href="#whisper-setup">Whisper Setup</a></li>
      </ul>
    </li>
    <li>
      <a href="#usage">Usage</a>
      <ul>
        <li><a href="#direct-commands">Direct Commands</a></li>
        <li><a href="#mcp-setup">MCP Setup</a></li>
      </ul>
    </li>
    <li><a href="#configuration">Configuration</a></li>
    <li>
      <a href="#development">Development</a>
      <ul>
        <li><a href="#mock-transcript-testing">Mock Transcript Testing</a></li>
        <li><a href="#integration-tests">Integration Tests</a></li>
        <li><a href="#quality-checks">Quality Checks</a></li>
        <li><a href="#build-bundled-app-macos">Build Bundled App (macOS)</a></li>
        <li><a href="#ralph-autonomous-development-loop">Ralph: Autonomous Development Loop</a></li>
      </ul>
    </li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->
## About The Project

[![HeyJamie Screen Shot][product-screenshot]](https://github.com/normand1/HeyJamie)

HeyJamie is a desktop app that listens to your microphone, transcribes speech locally with whisper.cpp, detects topic shifts, and automatically launches browser research deep dives or creates Excalidraw diagrams — all driven by LLM-powered automation.

Note: Currently MacOS only (adding Linux and Windows support soon!)

**How It Works:**

1. **Mic capture** — Records audio segments (8s windows, 2s minimum).
2. **Transcription** — Sends WAV segments to the local whisper-cli.
3. **Topic detection** — LLM identifies topic shifts in the transcript.
4. **Intent planning** — LLM decides action type: `browser` (web research) or `excalidraw` (diagram).
5. **Automation** — Chrome DevTools MCP runs browser research; Excalidraw MCP creates diagrams.
6. **Direct commands** — Say "Hey Jamie ..." for immediate browser command execution.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

[![Tauri][Tauri-badge]][Tauri-url]
[![React][React-badge]][React-url]
[![TypeScript][TypeScript-badge]][TypeScript-url]
[![Vite][Vite-badge]][Vite-url]
[![Tailwind CSS][Tailwind-badge]][Tailwind-url]
[![Rust][Rust-badge]][Rust-url]

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- GETTING STARTED -->
## Getting Started

Follow these steps to get a local copy up and running.

### Prerequisites

- **Node.js** — use `nvm` with the included `.nvmrc`
- **Rust toolchain** — required for Tauri
- **CMake + C/C++ build toolchain** — required for whisper.cpp

### Installation

1. Clone the repo
   ```sh
   git clone https://github.com/normand1/HeyJamie.git
   cd HeyJamie
   ```
2. Install Node version and dependencies
   ```sh
   nvm use
   npm install
   ```
3. Run in development mode
   ```sh
   npm run tauri dev
   ```

### Whisper Setup

On first launch, the app prompts to install whisper.cpp. This runs `scripts/setup-whisper.sh` which clones the repo, downloads the base model, and builds the CLI.

Default lookup paths:
- `whisper_cpp/build/bin/whisper-cli`
- `whisper_cpp/models/ggml-base.en.bin`

Overrides:
```sh
export WHISPER_CLI_PATH=/path/to/whisper-cli
export WHISPER_MODEL_PATH=/path/to/ggml-base.en.bin
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- USAGE -->
## Usage

### Direct Commands

Say **"Hey Jamie ..."** followed by a command for immediate browser action execution. The app captures your voice, transcribes it locally, and dispatches the appropriate automation.

### MCP Setup

HeyJamie uses MCP servers for browser automation and diagram generation. The default MCP config includes:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--ignore-default-chrome-arg=--enable-automation"]
    },
    "excalidraw": {
      "command": "node",
      "args": ["/path/to/mcp_excalidraw/dist/index.js"],
      "env": {
        "EXPRESS_SERVER_URL": "http://localhost:3000",
        "ENABLE_CANVAS_SYNC": "true"
      }
    }
  }
}
```

You can edit this in **Settings -> MCP Config**.

#### Excalidraw Canvas Server

The Excalidraw MCP uses [mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw), which requires a local canvas server:

```sh
# Clone and build
git clone https://github.com/yctimlin/mcp_excalidraw.git
cd mcp_excalidraw && npm ci && npm run build

# Start the canvas server (keep running)
HOST=0.0.0.0 PORT=3000 npm run canvas
```

The canvas server hosts a live Excalidraw editor at `http://localhost:3000` and provides a REST API for the MCP server to sync diagram elements in real time.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONFIGURATION -->
## Configuration

Set your OpenRouter API key in app Settings or via environment:

```sh
HEYJAMIE_OPENROUTER_API_KEY=your-key
# or
VITE_HEYJAMIE_OPENROUTER_API_KEY=your-key
```

Optional overrides:

| Variable | Default | Description |
|---|---|---|
| `HEYJAMIE_LLM_MODEL` / `VITE_HEYJAMIE_LLM_MODEL` | `anthropic/claude-sonnet-4.5` | LLM model |
| `HEYJAMIE_LLM_TIMEOUT_MS` | 45000 | General LLM timeout |
| `HEYJAMIE_INTENT_TIMEOUT_MS` | 90000 | Intent planner timeout |
| `HEYJAMIE_EXCALIDRAW_TIMEOUT_MS` | 120000 | Excalidraw agent timeout |
| `HEYJAMIE_BROWSEROS_TIMEOUT_MS` | 180000 | Browser automation timeout |

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- DEVELOPMENT -->
## Development

### Mock Transcript Testing

Run the app with pre-recorded transcripts for development and testing:

```sh
npm run tauri:dev:mock                          # default (cute-cats)
npm run tauri:dev:mock:excalidraw-diagram       # excalidraw scenario
npm run tauri:dev:mock:topic-changes            # topic shift scenario
npm run tauri:dev:mock:arxiv-html-preference    # arxiv HTML preference
npm run tauri:dev:mock:arxiv-quantum-rl-transformers  # arxiv quantum RL
```

### Integration Tests

End-to-end tests that launch the full Tauri app with a mock transcript, run browser/excalidraw automation, and evaluate results:

```sh
# Requires HEYJAMIE_OPENROUTER_API_KEY
set -a && source .env && set +a

# Run a scenario and print results
node scripts/eval-excalidraw-diagram.mjs

# Run with JSON report output
node scripts/eval-excalidraw-diagram.mjs --output /tmp/eval-report.json
```

Available scenarios: `excalidraw-diagram`, `arxiv-quantum-rl-transformers`, `arxiv-html-preference`

### Quality Checks

Run the build quality gate:

```sh
npm run quality-check                                                    # tsc + vite build
bash scripts/ralph/run-quality-checks.sh --scenario excalidraw-diagram   # build + integration test
bash scripts/ralph/run-quality-checks.sh --scenario excalidraw-diagram --min-score 90  # custom threshold
```

### Build Bundled App (macOS)

```sh
npm run tauri build -- --debug --bundles app
open "src-tauri/target/debug/bundle/macos/HeyJamie.app"
```

### Ralph: Autonomous Development Loop

[Ralph](https://github.com/snarktank/ralph) is an autonomous AI agent loop that drives Claude Code through repeated iterations to implement user stories from a PRD.

**Quick start:**

```sh
# 1. Create your PRD with stories
cp scripts/ralph/prd.json.example scripts/ralph/prd.json
# Edit prd.json with your stories

# 2. Run the loop (default: 10 iterations)
npm run ralph

# Or with a custom iteration limit
npm run ralph:20
```

**Key files:**

| File | Description |
|---|---|
| `scripts/ralph/ralph.sh` | Main loop orchestrator |
| `scripts/ralph/prompt.md` | Prompt template piped to each Claude Code invocation |
| `scripts/ralph/prd.json.example` | Example PRD to copy and customize |
| `scripts/ralph/prd.json` | Your stories (gitignored) |
| `scripts/ralph/progress.txt` | Progress log (gitignored) |
| `scripts/ralph/run-quality-checks.sh` | Standalone quality gate script |

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ROADMAP -->
## Roadmap

- [ ] Multi-language transcription support
- [ ] Additional MCP server integrations
- [ ] Plugin system for custom automation actions

See the [open issues](https://github.com/normand1/HeyJamie/issues) for a full list of proposed features and known issues.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTRIBUTING -->
## Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also simply open an issue with the tag "enhancement".

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- LICENSE -->
## License

Distributed under the MIT License. See `LICENSE` for more information.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTACT -->
## Contact

Project Link: [https://github.com/normand1/HeyJamie](https://github.com/normand1/HeyJamie)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ACKNOWLEDGMENTS -->
## Acknowledgments

* [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — Local speech-to-text engine
* [Chrome DevTools MCP](https://github.com/nichochar/chrome-devtools-mcp) — Browser automation via MCP
* [mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw) — Excalidraw diagram generation via MCP
* [OpenRouter](https://openrouter.ai/) — LLM API gateway
* [Tauri](https://tauri.app/) — Desktop app framework
* [shadcn/ui](https://ui.shadcn.com/) — UI component library
* [Best-README-Template](https://github.com/othneildrew/Best-README-Template) — README template

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
[contributors-shield]: https://img.shields.io/github/contributors/normand1/HeyJamie.svg?style=for-the-badge
[contributors-url]: https://github.com/normand1/HeyJamie/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/normand1/HeyJamie.svg?style=for-the-badge
[forks-url]: https://github.com/normand1/HeyJamie/network/members
[stars-shield]: https://img.shields.io/github/stars/normand1/HeyJamie.svg?style=for-the-badge
[stars-url]: https://github.com/normand1/HeyJamie/stargazers
[issues-shield]: https://img.shields.io/github/issues/normand1/HeyJamie.svg?style=for-the-badge
[issues-url]: https://github.com/normand1/HeyJamie/issues
[license-shield]: https://img.shields.io/github/license/normand1/HeyJamie.svg?style=for-the-badge
[license-url]: https://github.com/normand1/HeyJamie/blob/master/LICENSE
[product-screenshot]: images/screenshot.png
[Tauri-badge]: https://img.shields.io/badge/Tauri-24C8D8?style=for-the-badge&logo=tauri&logoColor=white
[Tauri-url]: https://tauri.app/
[React-badge]: https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB
[React-url]: https://reactjs.org/
[TypeScript-badge]: https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[Vite-badge]: https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white
[Vite-url]: https://vitejs.dev/
[Tailwind-badge]: https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white
[Tailwind-url]: https://tailwindcss.com/
[Rust-badge]: https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white
[Rust-url]: https://www.rust-lang.org/
