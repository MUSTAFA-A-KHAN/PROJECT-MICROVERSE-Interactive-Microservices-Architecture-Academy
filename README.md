# Microverse — Master Microservices Architecture

An interactive engineering academy for designing, building, debugging, deploying and scaling production-grade microservices in Go. Everything is built around one real system — an **Order Management System** — whose complete Go source ships in this repository and compiles.

It's built with plain HTML, CSS and vanilla JavaScript: no framework, no build step.

## Run it

Microverse loads lessons and source files with `fetch()`, so serve it over HTTP (opening `index.html` from disk won't work):

```bash
npm run dev            # zero-dependency Node server → http://localhost:5173
# or
python -m http.server 5173
```

Node 18+ (for `npm run dev`) or any static file server works. The page uses these CDN libraries (pinned versions): Tailwind CSS v4 browser build, Motion, GSAP + ScrollTrigger and Lenis, plus Google Fonts (Inter, JetBrains Mono). Lucide icons are vendored as a generated subset in `assets/icons/icons.js`.

## What's inside

| Area | What you can do |
|---|---|
| **10 modules, 78 lessons** | Foundations → Go engineering → service design → API gateway → communication → databases → 14 distributed-systems patterns → Docker → observability → Kubernetes. Each major concept covers what it is, why it's needed, how it works internally, the Go implementation, where it fits, what goes wrong, and production practice. 86 inline knowledge checks. |
| **Architecture Lab** (`#/lab`) | Draggable, zoomable canvas of the whole system. Simulate five request types, inject eight failures (service down, timeouts, HTTP 500s, Postgres, Redis, RabbitMQ, slow network), toggle timeouts / retries / circuit breakers / fallbacks / outbox, and read a timestamped event log plus a "what went wrong and how to fix it" analysis. Requests run on a virtual clock with Go-style context deadlines, so timeouts propagate and cancel nested work. |
| **Code Playground** (`#/playground`) | File explorer, tabs, highlighting and line numbers over the real Go codebase. Every file explains what it does, why it exists, how it connects, runtime behaviour and production issues, with line-anchored notes. Guided traces walk a request across files (gateway → Order Service → User Service → outbox → consumer). |
| **16 interactive widgets** | Architecture comparison, worker pools, token bucket, gateway request lifecycle, retry strategies, REST vs gRPC vs messaging, transaction anomalies, a query-plan lab, circuit breaker, saga, idempotency, load balancing, Docker Compose, Kubernetes rollouts/HPA, trace waterfall, and an incident-investigation dashboard. |
| **3-hour bootcamp** (`#/path`) | Six 30-minute sessions, each with objectives, an interactive explanation, an architecture walkthrough, a code walkthrough, a practical challenge and a quiz. |
| **8 engineering challenges** (`#/challenges`) | Incident-style scenarios at three levels: write your proposal (self-checked against a rubric), pick between candidate approaches with verdicts, then study the engineering answer, Go implementation and trade-offs. |
| **Progress** (`#/progress`, `#/assessment`) | Persistent progress in `localStorage`: lessons, quiz scores, concept mastery, weak concepts, challenges, bookmarks and active learning time. A 28-question knowledge check recommends what to study next. Export/import as JSON. |

Command palette: <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd> (full-text search over lessons, files, challenges and actions). Press <kbd>?</kbd> for all keyboard shortcuts.

### Simulated vs real

Everything labelled **Simulated** — the Lab, widgets, metrics, query plans — is generated in your browser by a model of the system; no network calls are made. The source in the Code Playground is **real**: it's the code in `codebase/order-management`, displayed rather than executed.

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
css/                    main (tokens, shell, prose) · components · features · widgets · pages · animations
js/                     state · ui · highlight · markdown · quiz · navigation · architecture (diagram engine)
                        simulator (Lab) · lessons · playground · challenges · bootcamp · progress · app
js/widgets/             kit (shared frame + SVG charts) and the 16 lesson widgets
data/                   lessons (catalog + concepts) · architectures (Lab + diagrams) · codebase (playground manifest)
                        challenges · bootcamp · assessment
content/                Lesson markdown (one file per module, "@@lesson <id>" sections) and challenge solutions
codebase/               The Order Management System (Go)
assets/icons/           Logo and generated Lucide icon subset
tools/                  serve.mjs · build-icons.mjs · check-content.mjs
```

### Authoring content

Lessons are Markdown with a few extensions: callouts (`:::tip`, `:::warn`, `:::rule` for mandatory practice, `:::rec` for trade-off recommendations, `:::sim`), `:::details`, inline quizzes (`:::quiz concept="…"`), checklists (`- [ ] …`), `::diagram{id="…"}` and `::widget{name="…"}` embeds, and fenced code with `title=` / `hl=` attributes.

After editing content or data, run:

```bash
npm run check   # every lesson section, diagram, widget, quiz, concept, link and code anchor resolves
npm run icons   # regenerate the icon subset (and flag unknown icon names)
```
