# L-science

[中文](README.md) · **English**

A local-first AI research workbench for Windows. Literature, claims, manuscripts, and Python/R kernels stay on your machine — no cloud backend.

**1.0.0** · Windows x64 · MIT · [GitHub](https://github.com/LiangyuLu-lly/L-science)

No macOS / Linux builds · no auto-update · unsigned installer

---

## Interface

After launch you land on **Literature**; the composer stays docked at the bottom.

![Workbench: literature home and docked assistant](docs/screenshots/workbench.svg)

First launch asks for an API key only; the kernel environment installs in the background.

![First-run overlay](docs/screenshots/first-run.svg)

![Paper path: DOI → claims → manuscript → assistant](docs/screenshots/flow.svg)

---

## What it is

The paper path is the product, not another chat window:

1. **Literature** — paste DOI / PMID / URL (Crossref by default)
2. **Claims** — unsupported and contradictory items sort first
3. **Manuscripts** — open a compile report; unresolved claims block “ready to submit”
4. **Assistant** — talk while looking at the paper; expand the transcript with 助手
5. **Studio** — artifacts, skills, connectors, routing, usage, settings

Model quality is entirely the key you register. No key, no intelligence.

---

## Can / cannot

**Can**

- Register several cloud gateways at once (Kimi, Qwen, OpenAI, Groq, OpenRouter, …)
- Local Ollama
- One-click micromamba + `lsci` / `lsci-r` (not bundled in the installer)
- Page-level text extract from digital PDFs
- Export a reproducibility zip and reveal it in Explorer
- Keys in DPAPI only; no telemetry

**Will not (on purpose)**

- Sign you up for a cloud account
- Ship conda / ColabFold / CUDA inside the NSIS package
- Inject red-light skill procedures as if they ran
- Silent auto-update, code signing, macOS / Linux

---

## Install

1. Get `L-science-Setup-1.0.0.exe` (after `npm run pack:win`, under `release/win/`).
2. SmartScreen “Windows protected your PC” → **More info → Run anyway**. Unsigned publisher is expected.
3. Per-user install; no administrator required.

Data lives in `%LOCALAPPDATA%\L-science`. Uninstall does **not** delete it. Multiple instances: set `L_SCIENCE_DATA_DIR`.

---

## First launch

1. Default provider is **Kimi**; switch to Qwen / OpenAI / Groq if you want.
2. Paste the API key into the password field, click **Start**. The key is wiped from the form immediately.
3. Python/R kernels install in the background: existing conda if present, otherwise micromamba under the data dir.
4. Running Ollama is detected automatically.
5. `api.crossref.org` is pre-allowed for literature; revoke it in Settings.

DeepSeek and manual conda commands live under “other / manual”. Skip opens Settings.

Fallback if one-click fails:

```text
conda create -n lsci python=3.13 ipykernel -y
conda create -n lsci-r -c conda-forge r-base r-irkernel -y
```

Or `scripts/bootstrap-kernels.ps1`.

---

## Daily use

1. **Literature**: paste a DOI → ingest. Failures show the upstream reason (e.g. Crossref 404).
2. Talk from the bottom composer without leaving the paper view.
3. **Claims**: handle unsupported items first.
4. **Manuscripts**: Compile produces Markdown and a check report, not a submission file (the reproducibility zip is in Artifacts). Unresolved claims block “ready to submit”.
5. **Artifacts**: exporting a zip reveals the folder.
6. OpenRouter / SiliconFlow / Together enable only a small default subset after sync.

Sidebar:

```text
Paper path
  Literature   (home)
  Claims
  Manuscripts
Assistant     transcript toggle (composer already docked)
Studio
  Artifacts / Skills / Connectors / Routing / Usage / Tools / Settings
```

---

## Privacy

- No telemetry
- Keys encrypted with Windows DPAPI, local only
- Uninstalling the setup does not wipe the data directory

---

## Development

Requires Node ≥ 24.

```powershell
npm install
npm run doctor
npm run dev:ui
npm run dev:shell
```

UI: `http://127.0.0.1:5223`. After control-plane changes, restart Electron; Vite can stay up.

```powershell
npm run pack:win
```

Output: `release/win/`. `vendor/` and `release/` are not committed.

---

## License

[MIT](LICENSE) © 2026 LiangyuLu-lly
