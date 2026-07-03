# Example 6 - From a plain-English question to a full dashboard

> **Note:** This is a short, high-level overview - the full tutorial is still a work in progress.

## What this AI agent example does

Give the agent a plain-English request and the URL of a SQLite database file, and it builds a full interactive HTML dashboard - metrics, charts, tables, and written insights. The request can be anything the data supports: "help me improve our sales" over a music store's catalog, or "show how baseball team performance changed across eras" over a century of stats. It starts by planning what to show, then fetches the data and renders each card - but the interesting part is everything it takes to get there cheaply and reliably. This started as a "planning" example and ended up being a small tour of agentic patterns working together.

## How it's done

The obvious way to build this is to hand a top-tier model a set of database tools and let it loop - inspect the schema, run queries, write HTML - until it's done. That works, but it's slow and expensive: every step waits on one big, pricey model, and each turn drags the whole growing conversation along with it.

This tutorial takes a different approach. The job is split into small, well-defined steps, each handed to the cheapest model that can do it, and the independent steps run in parallel. The whole dashboard comes out to about **50,000 tokens for 2-3 cents**, running roughly **6-7 prompts concurrently** on average, using only cheap models (OpenAI's GPT-nano and GPT-mini). Start to finish, the whole dashboard is ready in about **15 seconds** if LLM calls are not throttled (low OpenAI tier during peak hours).

## Example dashboards

Every dashboard below was produced by the same code - only the request and the database changed:

- **[Catalog Performance Analysis](https://raw.githack.com/geleto/casai-examples/main/src/6-planning/examples/catalog-perfomance.html)** - Chinook music store: genre, artist, album, and track performance to guide content and promotion decisions.
- **[Rental and Payment Activity Overview](https://raw.githack.com/geleto/casai-examples/main/src/6-planning/examples/rental-activity.html)** - Sakila DVD-rental store: where rental and payment activity concentrates across stores, customers, and staff.
- **[Film Catalog Demand Overview](https://raw.githack.com/geleto/casai-examples/main/src/6-planning/examples/film-demand.html)** - Sakila films: demand by category, rating, rental terms, and actors.
- **[Baseball Team Performance Across Eras](https://raw.githack.com/geleto/casai-examples/main/src/6-planning/examples/basebal-perfomance.html)** - Lahman archive: how team wins, scoring, and pitching shifted over 150 years.
- **[Taxonomic Coverage Overview](https://raw.githack.com/geleto/casai-examples/main/src/6-planning/examples/taxonomic-coverage.html)** - ITIS taxonomy: how organism records spread across kingdoms, ranks, and hierarchy depth.

## The building blocks

A handful of small, reusable pieces do all the work:

- **Prompt templates** - Each prompt lives in its own text file under [`templates/`](templates/), kept out of the code so it's easy to read and tweak. A template takes structured data as input and renders it into the finished prompt text - there's one per LLM call.
- **Text templates** - The other templates render text that isn't a prompt: the database schema summary that's fed into every prompt, and the final HTML page.
- **LLM calls** - Each prompt template is wrapped into a small, single-purpose function you just call - pinned to a model, and to a schema where it returns data. You'll meet each one in the steps below.
- **LLM output schemas** - Zod definitions describe the shape of a planned card and a rendered card, so every LLM that returns data hands back clean, typed fields instead of free-form text.
- **Helpers** - Plain TypeScript functions for the non-AI work: inspecting the SQLite database and running queries, trimming result previews, laying out the columns, and building the final page.
- **Orchestrator** - One short Cascada script in its own file, [orchestrator.cas](orchestrator.cas) (roughly 80 lines,), drives the whole run. It kicks off the three planners, then processes each card as it streams in: for a data card it builds a scoped schema, generates the SQL and runs it, and repairs a failed or empty query - retrying up to twice, escalating the model and then widening the schema, and dropping in an error note if it still fails. Insight cards also get a written takeaway; every card is then rendered into an HTML fragment. Finally it collects the finished cards into the dashboard. It reads like regular, sequential top-to-bottom code, but Cascada runs the independent parts in parallel at the same time.

Here's how those pieces run, in order.

## Steps used

- **Summarize the schema** *(no AI)* - Plain SQL inspects the database and builds a compact map of its tables, columns, sample values, and row counts. No model runs here; every later prompt is simply grounded in this summary, so the models only reach for columns that actually exist.
- **Plan the layout** *(planner)* - Three planner LLMs run at once, each choosing part of the dashboard: header + metrics, charts + tables, and insights + text.
- **Process each card as it streams** *(no AI - orchestration)* - Individual cards arrive from the planners as a stream and are handled the moment they're ready, not after the whole plan finishes. A data card runs the first four substeps below; every card, data or not, ends with a render:
  - **Narrow the schema** *(no AI)* - Build a scoped schema subset with just the tables this card asked for, so its SQL prompt stays small.
  - **Fetch the data** *(tool-style execution)* - An LLM writes the SQL from the plain-English request; the database - not the model - runs it, so the numbers are real, not guessed.
  - **Repair and fall back** *(repair loop + progressive fallback)* - On an error or empty result, an LLM rewrites the query with the error as feedback, escalating from the cheap model to a stronger one and then to the full schema. The retry loop and the graceful "show a note instead of breaking the page" fallback are plain code.
  - **Write the insight** *(LLM, insight cards only)* - Turn the query results into a few concise written takeaways.
  - **Render the card** *(structured output, every card)* - An LLM turns the card into a self-contained HTML/JS fragment, pinned to a schema so the fields come back clean.
- **Compose the page** *(no AI)* - Plain TypeScript lays out the columns and stitches the fragments together - no model for the last mile.

## The file behind each step

Every step is just a file you can open and read:

- **Summarize the schema** → [`schema-summary.txt`](templates/schema-summary.txt) - renders the schema metadata (tables, columns, sample values, row counts) into the compact summary every prompt is grounded in. The per-card *Narrow the schema* substep reuses this same template on a smaller set of tables.
- **Plan the layout** → [`header-metric-planner.md`](templates/header-metric-planner.md), [`visual-planner.md`](templates/visual-planner.md), [`insight-text-planner.md`](templates/insight-text-planner.md) - one prompt per planner, each choosing its slice of the dashboard.
- **Fetch the data** → [`sql-generator.md`](templates/sql-generator.md) - turns the card's plain-English data request into a single SQLite SELECT.
- **Repair and fall back** → [`sql-repair-generator.md`](templates/sql-repair-generator.md) - rewrites a failed or empty query, using the execution error as feedback.
- **Write the insight** → [`text-insight-generator.md`](templates/text-insight-generator.md) - turns the query results into a few short HTML takeaways.
- **Render the card** → [`element-renderer.md`](templates/element-renderer.md) - turns one enriched card into a self-contained HTML/JS fragment.
- **Compose the page** → [`dashboard-template.html`](templates/dashboard-template.html) - wraps all the fragments into the final page with shared helpers and data.
- **All of it, in order** → [`orchestrator.cas`](orchestrator.cas) - runs the planners and walks every card through the steps above.

## Speed and cost optimizations

- **Everything that can run in parallel does** - The orchestration script reads like plain sequential code, but Cascada runs it concurrently under the hood: it works out what doesn't depend on what and fires independent planners, queries, and renders at the same time (about 6-7 prompts in flight on average), with no `Promise.all` or `await`. The dashboard finishes in a fraction of the time a step-by-step loop would take.
- **Cheap model for the grunt work** - A small, cheap model (nano) drafts the SQL and renders card HTML - the high-volume, low-judgment tasks.
- **Stronger model only where it counts** - Planning, SQL repair, and writing insight text use the more capable model (mini), since those actually need reasoning.
- **Cheap first, escalate on failure** - The first SQL attempt always uses the cheap model; you only pay for the stronger one when a query genuinely breaks.
- **Prompt caching** - Prompts put the fixed instructions first and the changing bits last (and share a cache key), so the provider reuses the repeated part instead of charging for it every call.
- **Send only the schema you need** - Each SQL prompt gets just the tables that card asked for, not the whole database, which means fewer tokens per call.
- **Keep prompts small** - Result previews are trimmed to a few rows, and full data is attached only after rendering, so prompts never balloon with raw query results.
- **Built-in cost meter** - A logging wrapper prints tokens, cache hits, concurrency, and estimated dollars, so you can see what each optimization actually saves.
