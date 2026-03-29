# Labby – Academic Seminar Scheduler

Labby is a browser-based intelligent seminar scheduling system built with:

- **pnpm workspaces** – monorepo with `@labby/core` (pure algorithms) and `@labby/web` (UI)
- **Preact + Signals** – fine-grained reactive UI
- **Vite** – fast dev/build tooling
- **vanilla-extract** – zero-runtime type-safe CSS
- **D3.js** – keyword similarity force graph
- **idb** – IndexedDB abstraction for persistent local storage
- **@msgpack/msgpack** – compact binary backup format
- **PapaParse** – CSV export

## Features

- Manage persons and research keywords with multilingual names (English / 中文 / 日本語)
- Build keyword similarity via interactive triplet comparisons (triplet-loss gradient descent)
- Visualise keyword relationships as a D3 force graph with brush-select attract/repel interactions
- Generate full semester schedules via simulated annealing (uniformity, questioner diversity, domain relevance)
- Incremental reschedule with minimal churn (Hamming penalty)
- Export schedule as HTML (paste-able into email), CSV, or full database backup (.labby / .json)
- Auto-deploy to GitHub Pages and Netlify

## Getting Started

```bash
# Prerequisites: Node ≥ 20, pnpm ≥ 10
corepack enable
pnpm install

# Development server
pnpm dev

# Production build
pnpm build
```

## Deployment

- **GitHub Pages**: push to `main` → `.github/workflows/deploy-pages.yml` builds and deploys.
- **Netlify**: push to `main` → `.github/workflows/deploy-netlify.yml` deploys.
  Set `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID` in GitHub repository secrets.

## Project Structure

```
labby/
├── pnpm-workspace.yaml
├── netlify.toml
├── .github/workflows/
│   ├── deploy-pages.yml
│   └── deploy-netlify.yml
└── packages/
    ├── core/              # @labby/core – pure algorithms & types
    │   └── src/
    │       ├── types.ts   # entity interfaces
    │       ├── nlp.ts     # triplet-loss embedding engine
    │       └── solver.ts  # simulated-annealing scheduler
    └── web/               # @labby/web – Preact + Vite UI
        └── src/
            ├── store/     # Preact Signals state
            ├── db/        # IndexedDB (idb)
            ├── components/# UI components
            ├── i18n/      # zh / en / ja dictionaries
            └── styles/    # vanilla-extract CSS
```