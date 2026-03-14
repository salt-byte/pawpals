<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/350b6cc1-090f-4715-9cd1-6b630baec866

## Run Locally

**Prerequisites:**  Node.js

1. Install dependencies:
   `npm install`
2. Optional runtime overrides for an app-scoped deployment:
   `PAWPALS_HOME`, `OPENCLAW_HOME`, `OPENCLAW_BASE_URL`, `OPENCLAW_BIN`, `PAWPALS_PYTHON`, `PAWPALS_PORT`
3. Run the app:
   `npm run dev`

By default the app now prefers an isolated PawPals data directory and only falls back to `~/.openclaw` when no app-local OpenClaw home exists yet. This makes it easier to package PawPals as a self-contained desktop app later.

## Isolated Runtime

Use these commands when you want PawPals to manage its own OpenClaw runtime instead of reading directly from your personal `~/.openclaw` state:

1. Initialize an app-scoped runtime:
   `npm run bootstrap:runtime`
2. Start PawPals with its own OpenClaw home and a dedicated local gateway:
   `npm run dev:isolated`

Notes:
- The isolated runtime lives under `PAWPALS_HOME` (defaults to `~/Library/Application Support/PawPals` on macOS).
- `dev:isolated` defaults to `OPENCLAW_PORT=18790` and `PAWPALS_PORT=3010`, so it does not need to reuse your primary OpenClaw gateway on `18789` or your local web app on `3000`.
- By default, local developer bootstraps copy the current machine's OpenClaw secrets so you can test immediately. Set `PAWPALS_COPY_SECRETS=0` when preparing a distributable template.
- For a clean distributable build, point `OPENCLAW_TEMPLATE_DIR` at a sanitized template directory instead of cloning from your own `~/.openclaw`.
- Refresh the sanitized distributable template at any time with:
  `npm run template:refresh`

## Desktop App

PawPals now includes an Electron shell that boots the isolated OpenClaw runtime for you.

1. Install dependencies:
   `npm install`
2. Start the desktop app in development:
   `npm run desktop:dev`
3. Build a distributable desktop package:
   `npm run desktop:build`

Notes:
- `desktop:dev` launches Electron and starts PawPals plus its isolated OpenClaw runtime automatically.
- `desktop:dev` defaults to `PAWPALS_PORT=3010`; override it with `PAWPALS_PORT=<port>` if needed.
- `desktop:build` currently targets macOS (`.dmg` and `.zip`) through `electron-builder`.
- Before creating a shareable build, use a sanitized template (`PAWPALS_COPY_SECRETS=0`) so your personal API keys do not ship inside the app.
