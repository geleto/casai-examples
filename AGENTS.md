# AGENTS.md

## 1. Purpose & Goals

Each example in this repo demonstrates a specific pattern **and**, equally importantly, illustrates certain **Casai API components** and **Cascada Script capabilities**.

When modifying or creating examples:

* Preserve clarity.
* Prefer minimal, idiomatic usage of Casai and Cascada.
* Treat these examples as **API references** for how to use various Casai building blocks.

---

## 2. Mental Model: Casai & Cascada Script

### 2.1 Casai

Casai is a TypeScript AI orchestration library built on:

* **Vercel AI SDK Core** for model calls, tools, structured outputs.
* **Cascada** for template and script execution.

Key ideas:

* Components are created via `create.*`:

  * `TextGenerator`, `ObjectGenerator`, `Script`, `Template`, `Function`, `Config`
* Components are **callable** (`await component(args)`), with optional `.run()`
* Composition via:

  * `.withTemplate`
  * `.loadsTemplate`
  * `.withScript`
  * `.asTool`
  * `.withConfig`

Schemas are provided using **Zod**.

### 2.2 Cascada Script

A **parallel-by-default orchestration language** embedded in JS.

Important concepts:

* **Dataflow execution**: no `await`; operations run when inputs are ready.
* **Parallel loops**: `for … in …`
* **Sequential loops**: `while`, `each`
* **Loop concurrency limits**: `for x in y of N`
* **Structured output**: `@data`, `@text`, focus blocks `:data`, `:text`
* **Poisoned values** (`is error`) for safe error handling
* **Templates** with Nunjucks-like syntax

---

## 3. Additional API Reference

For the complete Casai API documentation, see the **Casai README**:
[./node_modules/casai/README.md](./node_modules/casai/README.md)

For the Cascada documentation, see the **Cascada README**:
[./node_modules/cascada-engine/dist/docs/README.md](./node_modules/cascada-engine/dist/docs/README.md)

For the Cascada Script documentation, see the **Cascada Script Documentation**:
[./node_modules/cascada-script/dist/docs/script.md](./node_modules/cascada-script/dist/docs/script.md)


## 4. Project Structure & Conventions

From `README.md`:

* Each example lives in `src/N-name/`
* Typical files:

  * `index.ts` (main orchestration)
  * `input.txt` or `input.json`
  * `templates/` if needed
  * Optional `types.ts` with Zod schemas

Use:

```bash
npm run example 1
npm run example 2
…
```

---

## 5. General Rules for Modifying / Creating Examples

### 5.1 Keep Examples Focused and Idiomatic

Each example should clearly demonstrate the Casai/Cascada API feature it was designed to illustrate.

### 5.2 Reuse Provided Configurations

* `basicModel` for lightweight tasks
* `advancedModel` for reasoning-heavy tasks

### 5.3 Respect Casai Component Patterns

Use the right component for the underlying need:

* Prompt templates → `TextGenerator.withTemplate`
* Structured outputs → `ObjectGenerator` + `schema`
* Internal logic → `Script`
* Tool integration → `.asTool()`

### 5.4 Use Zod for All Structured Output

Schemas ensure reliability and safety.

### 5.5 Cascada Script Style

Follow established idioms:

* Use `@data`, `capture :data`, `is error`
* Keep parallel loops parallel unless strict ordering is required
* Never mix JS async control primitives inside Cascada Script workflows

---

## 6. Example-Specific **API Usage References**

Below, each example tells agents **what Casai/Cascada API usage it demonstrates**.
Use these references when implementing new examples or modifying existing ones.

This list is **not** about agentic patterns; it is specifically about:

* which **Casai components** the example uses,
* which **Cascada Script constructs** appear,
* which **non-overlapping features** can be taken as reference for future examples,
* and where certain implementations (e.g., enum classification, schema usage, tools) can be copied.

---

## 6.1 Example 1 — **Prompt Chaining**

**Directory:** `src/1-prompt-chaining/`

**Casai API usage illustrated:**

* **TextGenerator.withTemplate**
  Reference for defining multiple simple renderers each with a templated prompt.
* **create.Config**
  Shows how to define a baseline config reused across multiple generators.
* **Basic generator-to-generator chaining**
  Demonstrates how outputs from one generator (`.text`) feed another generator's inputs.

**Cascada Script usage illustrated:**

* **Strictly linear script** with no loops or conditionals.
  Good reference when you want a clean, synchronous dataflow.
* **Basic `@data` population**
  Shows how to populate output fields from a script.

**Use this example when you need to reference:**

* How to implement and call multiple `TextGenerator.withTemplate` components.
* How to set up a simple `Script` with sequential operations.
* How to pass data between generators cleanly.

---

## 6.2 Example 2 — **Routing (Classification + Handler Mapping)**

**Directory:** `src/2-routing/`

**Casai API usage illustrated:**

* **ObjectGenerator.withTemplate + `output: 'enum'`**
  This example is the canonical reference for enum classification.
  Use this when you need to classify inputs into discrete labels.
* **Mapping classifier output to component instances**
  The `handlers[category]` pattern is a clean reference for using dynamic component selection.
* **Different Configs per component**
  Demonstrates how to define multiple configs (`quickResponseConfig`, `detailedResponseConfig`) and attach each to specific generators.

**Cascada Script usage illustrated:**

* **Conditional execution (`if handler ... else ...`)**
  Reference script for branch-based routing.
* **Reading input from file in context + passing into script**
  Shows how to embed external side-effects in the script’s context.

**Use this example when you need to reference:**

* How to build an enum classifier in Casai.
* How to branch logic inside Cascada Script.
* How to dynamically pick a `TextGenerator` based on model output.

---

## 6.3 Example 3 — **Parallelization (Large Workflows)**

**Directory:** `src/3-parallelization/`

This is the most complete reference for **Casai + Cascada together**.

**Casai API usage illustrated:**

* **ObjectGenerator.loadsTemplate** and **TextGenerator.loadsTemplate** with `FileSystemLoader`
  Reference for large projects using external template files.
* **Schemas for arrays and nested structures**
  `StockListSchema`, `ComponentScoresSchema`, etc. show real-world schema composition.
* **Using ObjectGenerator for array return values (`output: 'array'`)**
* **Using Template.loadsTemplate for final rendering**
  `outputTemplate(result)` demonstrates template-to-string rendering.
* **Combining TS helpers with Cascada Script**
  E.g., math in JS (`calculateFinalScore`), ranking in JS, LLM for narrative.

**Cascada Script usage illustrated:**

* **Parallel `for` loops** as primary orchestration mechanism.
* **`capture :data` blocks** to accumulate outputs from parallel steps.
* **Error flow control using `is error`** to skip failing items.
* **Nested parallelism**: parallel markets → parallel stocks.
* **Combining JS functions in script context**
  (`fetchYahooFinance`, `calculateFinalScore`, etc.)

**Use this example when you need to reference:**

* How to do parallel execution in Cascada Script.
* How to integrate external APIs inside Cascada loops.
* How to build complex LLM workflows with typed schemas and templates.
* How to use `capture :data`, `is error`, and multi-step data assembly.

This example is the **primary reference** for:

* Array/object schemas in Casai
* Template loading from the filesystem
* Multi-step dataflow with parallelism

---

## 6.4 Example 4 — **Reflection (Self-Critique Loop)**

**Directory:** `src/4-reflection/`

**Casai API usage illustrated:**

* **ObjectGenerator.withTemplate + structured schema**
  Reference for producing multiple fields (`score`, `suggestions[]`).
  Use this when you need a structured critique or multi-field evaluation.
* **Using multiple generators with differing models**
  The critique generator overrides the model while still inheriting config defaults.

**Cascada Script usage illustrated:**

* **Sequential `while` loop**
  This is the canonical reference for sequential loops in Cascada.
  Use this when strict ordering is needed and parallelism must not occur.
* **Conditional acceptance of revisions**
  Shows “compare + overwrite” logic implemented in Cascada.
* **Mutable variables** (`var currentDraft = …; currentDraft = revisedDraft;`)
  Reference for stateful script evolution.

**Use this example when you need to reference:**

* Implementing loops (`while`) in Cascada Script.
* Implementing sequential improvement cycles.
* Using ObjectGenerator for structured feedback.

---

## 6.5 Example 5 — **Tool Use (LLM Tools + HTTP Tools)**

**Directory:** `src/5-tool/`

**Casai API usage illustrated:**

* **`.asTool()` for both Function tools and LLM-powered tools**

  * `create.ObjectGenerator.withTemplate.asTool`
  * `create.Function.asTool`
    This example is the **canonical reference** for tool creation.
* **Zod `inputSchema` + structured outputs for tools**
* **Mixed tool types**:

  * LLM-based tool (parsing natural-language time references)
  * HTTP function tool (geocoding)
  * HTTP function tool (weather fetch)
* **Passing tools to a TextGenerator via `tools: { ... }`**
* **Limiting tool recursion** via `stopWhen: stepCountIs(n)`

**Cascada Script usage illustrated:**

* None.
  The orchestration here is entirely inside a **Tool-enabled TextGenerator**.

**Use this example when you need to reference:**

* How to write a new tool as `create.Function.asTool`.
* How to convert an LLM prompt into a tool via `.asTool`.
* How to define tool input/output schemas.
* How to attach tools to a `TextGenerator`.
* How to enforce step limits.

---

## 7. Adding a New Example

Follow the existing project structure:

1. Create `src/<N>-<name>/`
2. Add:

   * `index.ts`
   * `input.txt` / `input.json`
   * Optional `templates/` and `types.ts`
3. Reuse `basicModel` and `advancedModel`
4. Choose the **minimal necessary** Casai components
5. Prefer the fewest number of prompts/templates needed to demonstrate the API usage
6. Test via `npm run example N`

When selecting which example to copy from, use the references in Section 6:

* Need structured classification? → Example 2
* Need parallel loops? → Example 3
* Need strict sequential loops? → Example 4
* Need tools? → Example 5
* Need simple template-based renderers chained together? → Example 1