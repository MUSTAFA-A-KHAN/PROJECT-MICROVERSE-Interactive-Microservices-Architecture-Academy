# Microverse — Master Microservices Architecture

An interactive engineering academy for designing, building, debugging, deploying and scaling production-grade microservices in Go. Everything is built around one real system — an **Order Management System** — whose complete Go source ships in this repository and compiles.

It's built with plain HTML, CSS and vanilla JavaScript: no framework, no build step.

## Run it

Microverse loads lessons and source files with `fetch()`, so serve it over HTTP (opening `index.html` from disk won't work):

```bash
npm run dev            # zero-dependency Node server → http://localhost:5173
# or any static file server:
python -m http.server 5173
```

Everything works on a static server, including **writing and running Go** in the Code Lab: code runs in the browser on a Go interpreter compiled to WebAssembly. `npm run dev` (Node 18+) adds two more engines through a small local API: the real Go toolchain on your machine (install [Go](https://go.dev/dl/)) and the official Go Playground at go.dev. It also enables *Build & test* for the reference services in the Code Playground. The page uses these CDN libraries (pinned versions): Tailwind CSS v4 browser build, Motion, GSAP + ScrollTrigger and Lenis, plus Google Fonts (Inter, JetBrains Mono). Lucide icons are vendored as a generated subset in `assets/icons/icons.js`.

## What's inside

| Area | What you can do |
|---|---|
| **10 modules, 78 lessons** | Foundations → Go engineering → service design → API gateway → communication → databases → 14 distributed-systems patterns → Docker → observability → Kubernetes. Each major concept covers what it is, why it's needed, how it works internally, the Go implementation, where it fits, what goes wrong, and production practice. 86 inline knowledge checks. |
| **Architecture Lab** (`#/lab`) | Draggable, zoomable canvas of the whole system. Simulate five request types, inject eight failures (service down, timeouts, HTTP 500s, Postgres, Redis, RabbitMQ, slow network), toggle timeouts / retries / circuit breakers / fallbacks / outbox, and read a timestamped event log plus a "what went wrong and how to fix it" analysis. Requests run on a virtual clock with Go-style context deadlines, so timeouts propagate and cancel nested work. |
| **Code Lab** (`#/code`) | Write Go in the browser and run it for real. 11 exercises (errors → status codes, order state machine, HTTP middleware, context deadlines, retries with backoff, worker pool, token bucket, idempotency keys, circuit breaker, saga, transactional outbox), each with a brief, progressive hints, a test suite you run with <kbd>Ctrl</kbd>+<kbd>Enter</kbd>, and a reference solution. Plus a free-form **Go scratchpad**. The editor has Go highlighting, auto-indent, bracket pairing, comment toggling, `gofmt` formatting and compiler errors marked on the right line. Lessons and bootcamp sessions link to the matching exercise. |
| **Code Playground** (`#/playground`) | File explorer, tabs, highlighting and line numbers over the real Go codebase. Every file explains what it does, why it exists, how it connects, runtime behaviour and production issues, with line-anchored notes. Guided traces walk a request across files (gateway → Order Service → User Service → outbox → consumer). **Edit mode** lets you change any service's `.go` files. With `npm run dev` and Go installed, *Build & test* runs `go build`, `go vet` and `go test` on a temporary copy of the service; elsewhere it checks syntax in the browser. Either way you can download your edits as a `git apply`-able patch. |
| **16 interactive widgets** | Architecture comparison, worker pools, token bucket, gateway request lifecycle, retry strategies, REST vs gRPC vs messaging, transaction anomalies, a query-plan lab, circuit breaker, saga, idempotency, load balancing, Docker Compose, Kubernetes rollouts/HPA, trace waterfall, and an incident-investigation dashboard. |
| **3-hour bootcamp** (`#/path`) | Six 30-minute sessions, each with objectives, an interactive explanation, an architecture walkthrough, a code walkthrough, a practical challenge and a quiz. |
| **8 engineering challenges** (`#/challenges`) | Incident-style scenarios at three levels: write your proposal (self-checked against a rubric), pick between candidate approaches with verdicts, then study the engineering answer, Go implementation and trade-offs. |
| **Progress** (`#/progress`, `#/assessment`) | Persistent progress in `localStorage`: lessons, quiz scores, concept mastery, weak concepts, challenges, Code Lab code and results, bookmarks and active learning time. A 28-question knowledge check recommends what to study next. Export/import as JSON. |

Command palette: <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd> (full-text search over lessons, files, challenges and actions). Press <kbd>?</kbd> for all keyboard shortcuts.

### Simulated vs real

Everything labelled **Simulated** — the Lab, widgets, metrics, query plans — is generated in your browser by a model of the system; no network calls are made. The source in the Code Playground is **real**: it's the code in `codebase/order-management`, displayed rather than executed.

Code you run in the **Code Lab** (and Playground edit mode) is **really compiled and executed**, never simulated:

| Engine | Where it runs | Notes |
|---|---|---|
| **In browser** (always available) | This tab, in a Web Worker | A Go interpreter ([Yaegi](https://github.com/traefik/yaegi)) compiled to WebAssembly, with `go/types` for compile errors in the compiler's words and `go/format` for gofmt. About 8.5 MB, downloaded the first time you press Run. Standard library only; 15-second limit; nothing leaves the browser. |
| **Local Go** (default when Go is installed) | Your machine, via `npm run dev` | The real gc compiler. Each run builds in a fresh temporary folder with `GOTOOLCHAIN=local`, no module downloads, a 10-second run limit and 128 KB output cap. One job at a time. |
| **Go Playground** | go.dev, via `npm run dev` | Your code (and the exercise tests) are sent to go.dev. The Code Lab asks before the first send. go.dev doesn't accept requests from other websites, so this needs the dev server. |

The in-browser engine is an interpreter, not the gc compiler, so `tools/wasm` closes the gaps that matter here. It rejects unused variables and imports and missing returns, and gives loops Go 1.22's per-iteration variables. It supports `range` over integers, the `min`/`max` builtins, type switches, generic type inference, `errors.As`, `%w` wrapping and `Error()`/`String()` methods in `fmt`. All without moving line numbers in error messages. Three small Yaegi bugs are patched at build time (see `tools/build-wasm.mjs`). Every exercise behaves identically on both engines, and `npm run check:runner` compares its output with the Go toolchain's. Known differences: `%T` and `%+v` print the interpreter's names for your types, a slice of `Stringer` values prints the raw values, and only the standard library is available.

Playground edit mode never writes to `codebase/`. Your drafts live in `localStorage`, and *Build & test* copies the service to a temporary folder, applies them, runs the Go toolchain and deletes the copy.

The execution API exists only in `tools/serve.mjs`. Because it runs code, the server binds to `127.0.0.1` and the API rejects requests that aren't same-origin from localhost (Host and Origin checks plus a custom header that a cross-site page can't send without a preflight). Setting `HOST` to anything else switches the API off. Don't expose this server to a network.

## Deploy to GitHub Pages

The site is static, so it runs on GitHub Pages with every feature except the two server-backed engines (Local Go and Go Playground) and the services' *Build & test*.

1. Push the repository to GitHub.
2. In **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**.
3. Push to `main` (or run the workflow from the **Actions** tab).

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) checks the course content, rebuilds the in-browser Go engine from `tools/wasm`, verifies every exercise on that engine and on the real Go toolchain, compares the engine's output with Go's, and only then publishes. Hash routing and relative paths mean the site works from a project URL such as `https://<user>.github.io/<repo>/`. `.nojekyll` makes Pages serve every file as-is.

## The reference system

`codebase/order-management/` holds four independently deployable Go 1.26 services (each its own module), SQL migrations, multi-stage Dockerfiles, a Docker Compose environment and Kubernetes manifests:

```bash
cd codebase/order-management
cp .env.example .env           # set JWT_SECRET
docker compose up --build      # gateway on :8080, RabbitMQ UI on :15672
./scripts/smoke.sh             # register → login → idempotent order → cancel
make build test vet            # across all four modules
```

See [codebase/order-management/README.md](codebase/order-management/README.md).

## Project structure

```text
index.html              App shell (single page, hash routing)
css/                    main (tokens, shell, prose) · components · features · widgets · pages · codelab · animations
js/                     state · ui · highlight · markdown · quiz · navigation · architecture (diagram engine)
                        simulator (Lab) · lessons · playground · editor · runner · gowasm + goworker
                        (in-browser Go engine) · codelab · challenges
                        bootcamp · progress · app
js/widgets/             kit (shared frame + SVG charts) and the 16 lesson widgets
data/                   lessons (catalog + concepts) · architectures (Lab + diagrams) · codebase (playground manifest)
                        challenges · bootcamp · assessment · exercises (Code Lab manifest + hints)
content/                Lesson markdown (one file per module, "@@lesson <id>" sections), challenge solutions,
                        exercises/<id>/ (README, starter, tests, solution) and the shared testkit
codebase/               The Order Management System (Go)
assets/icons/           Logo and generated Lucide icon subset
tools/                  serve.mjs (static server + Go API) · gorunner.mjs · build-icons.mjs
                        check-content.mjs · check-exercises.mjs · check-runner.mjs
                        build-wasm.mjs · wasmrun.mjs · wasm/ (the in-browser Go engine, Go source)
assets/go/              runner.wasm.gz · wasm_exec.js · runner.json (built by build-wasm.mjs)
```

### Authoring content

Lessons are Markdown with a few extensions: callouts (`:::tip`, `:::warn`, `:::rule` for mandatory practice, `:::rec` for trade-off recommendations, `:::sim`), `:::details`, inline quizzes (`:::quiz concept="…"`), checklists (`- [ ] …`), `::diagram{id="…"}` and `::widget{name="…"}` embeds, and fenced code with `title=` / `hl=` attributes.

After editing content or data, run:

```bash
npm run check       # every lesson section, diagram, widget, quiz, concept, link and code anchor resolves
npm run exercises     # every starter fails and every solution passes, on both engines
npm run build:wasm    # rebuild assets/go/runner.wasm.gz after changing tools/wasm (needs Go)
npm run check:runner  # the in-browser engine's output must match the Go toolchain's
npm run icons       # regenerate the icon subset (and flag unknown icon names)
```

### Adding a Code Lab exercise

Create `content/exercises/<id>/` with `README.md`, `starter.go.txt`, `tests.go.txt` and `solution.go.txt` (plus `support.go.txt` for read-only helpers), then add an entry to `data/exercises.js`. All files are `package main`. The tests file calls `runTests([]testCase{{"name", func(t *T) {...}}, ...})` from the shared `testkit.go.txt`, which prints `PASS`/`FAIL`/`RESULT` lines that the Code Lab turns into a checklist. Sources use `.go.txt` so Go tooling doesn't treat the folders as packages. Embed the exercise in a lesson with `::widget{name="exercise" id="<id>"}`.
