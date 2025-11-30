/**
 * PLANNING PATTERN EXAMPLE: DASHBOARD GENERATOR
 *
 * High-level flow:
 * 1. Read input.json (dataset + user request).
 * 2. Ensure SQLite DB is downloaded to ./database/<datasetName>.db.
 * 3. Extract a concise schema summary.
 * 4. Run Planner LLM:
 *    - Sees dataset + schema + userRequest.
 *    - Can call dataTool to fetch data samples.
 *    - Returns a textual DASHBOARD PLAN (required format).
 * 5. Run Generator LLM:
 *    - Takes the plan, schema, and request.
 *    - Outputs a single <body>...</body> element that uses Bootstrap 5 + Chart.js.
 * 6. Wrap body in a fixed HTML wrapper and save dashboard.html.
 */

import { create } from 'casai';
import { basicModel, advancedModel } from '../setup';
import { z } from 'zod';
import BetterSqlite3 from 'better-sqlite3';
import fs from 'fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stepCountIs } from 'ai';

// ---------------------------------------------------------------------------
// Types & paths
// ---------------------------------------------------------------------------

interface DashboardInput {
	datasetName: string;
	datasetDescription: string;
	databaseUrl: string;
	userRequest: string;
}

interface SqliteStatement<T = unknown> {
	all(): T[];
}

interface SqliteDatabase {
	prepare<T = unknown>(sql: string): SqliteStatement<T>;
	close(): void;
}

type SqliteDatabaseConstructor = new (
	filename: string,
	options?: { readonly?: boolean }
) => SqliteDatabase;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INPUT_PATH = path.join(__dirname, 'input.json');
const DATA_DIR = path.join(__dirname, 'database');
const OUTPUT_HTML = path.join(__dirname, 'dashboard.html');
const rawBetterSqlite3: unknown = BetterSqlite3;

// ---------------------------------------------------------------------------
// Filesystem & DB helpers
// ---------------------------------------------------------------------------

function ensureDataDir() {
	if (!existsSync(DATA_DIR)) {
		mkdirSync(DATA_DIR, { recursive: true });
	}
}

function openReadonlyDatabase(dbPath: string): SqliteDatabase {
	const DatabaseConstructor = rawBetterSqlite3 as SqliteDatabaseConstructor;
	return new DatabaseConstructor(dbPath, { readonly: true });
}

function getDbPath(datasetName: string): string {
	return path.join(DATA_DIR, `${datasetName}.db`);
}

async function loadInput(): Promise<DashboardInput> {
	const raw = await fs.readFile(INPUT_PATH, 'utf-8');
	const parsed = JSON.parse(raw) as DashboardInput;

	if (
		!parsed.datasetName ||
		!parsed.datasetDescription ||
		!parsed.databaseUrl ||
		!parsed.userRequest
	) {
		throw new Error(
			'input.json must contain datasetName, datasetDescription, databaseUrl, and userRequest.'
		);
	}



	return parsed;
}

/**
 * Download the SQLite DB to ./database/<datasetName>.db if it does not exist yet.
 */
async function downloadDatabaseIfMissing(
	datasetName: string,
	databaseUrl: string
): Promise<string> {
	ensureDataDir();
	const dbPath = getDbPath(datasetName);

	if (existsSync(dbPath)) {
		return dbPath;
	}

	console.log(
		`Downloading SQLite DB for dataset "${datasetName}" from ${databaseUrl}...`
	);
	const response = await fetch(databaseUrl);
	if (!response.ok) {
		throw new Error(
			`Failed to download DB from ${databaseUrl}. HTTP ${response.status} ${response.statusText}`
		);
	}
	const arrayBuffer = await response.arrayBuffer();
	const buffer = Buffer.from(arrayBuffer);
	await fs.writeFile(dbPath, buffer);
	console.log(`Saved DB to ${dbPath}`);
	return dbPath;
}

// ---------------------------------------------------------------------------
// Schema extraction (LLM-friendly summary)
// ---------------------------------------------------------------------------

function extractSchemaSummary(dbPath: string, datasetName: string): string {
	const db = openReadonlyDatabase(dbPath);
	try {
		const tables = db
			.prepare<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
			)
			.all();

		const lines: string[] = [];
		lines.push(`Dataset: ${datasetName}`);
		lines.push('');
		lines.push('Tables:');
		lines.push('');

		tables.forEach((table, idx) => {
			const tableName = table.name;
			const escaped = tableName.replace(/"/g, '""');
			const pragmaRows = db
				.prepare<{
					cid: number;
					name: string;
					type: string | null;
					notnull: 0 | 1;
					dflt_value: unknown;
					pk: 0 | 1;
				}>(`PRAGMA table_info("${escaped}")`)
				.all();

			lines.push(`${idx + 1}. ${tableName}`);
			pragmaRows.forEach((col) => {
				const type = col.type ?? 'UNKNOWN';
				const pkSuffix = col.pk ? ', primary key' : '';
				lines.push(`   - ${col.name} (${type}${pkSuffix})`);
			});
			lines.push('');
		});

		return lines.join('\n').trimEnd();
	} finally {
		db.close();
	}
}

// ---------------------------------------------------------------------------
// dataTool implementation
// ---------------------------------------------------------------------------

const collectedData: Record<string, unknown> = {};
let dataPointCounter = 1;

/**
 * Replacer for JSON.stringify used in preview JSON.
 * Ensures bigint and Date values are serialized safely.
 */
function previewReplacer(_key: string, value: unknown): unknown {
	if (typeof value === 'bigint') {
		const num = Number(value);
		return Number.isSafeInteger(num) ? num : value.toString();
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	return value;
}

/**
 * LLM-powered SQL generator.
 * Takes a natural-language data request plus schema/context and returns
 * a single SQLite SELECT query as plain text.
 */
const sqlFromRequestGenerator = create.TextGenerator.withTemplate({
	model: advancedModel,
	temperature: 0,
	prompt: `
You are a SQL generator for a SQLite database.

You are given:
- Dataset description:
{{ datasetDescription }}

- SQLite schema summary:
{{ schemaSummary }}

- Natural language data request:
{{ dataRequest }}

Your task:
- Write a single, syntactically valid SQLite SELECT query that best satisfies the data request.
- Only use tables and columns that appear in the schema summary.
- Prefer reasonably small result sets suitable for previews (use LIMIT when appropriate).
- Do not explain the query.
- Do not surround it with backticks or any other formatting.
- Do not include comments.

Return ONLY the SQL SELECT statement.
`.trim(),
});

const dataTool = create.Function.asTool({
	description:
		'Queries the local SQLite dataset and returns a JSON data file plus a truncated preview JSON. Full data is stored on disk, not passed through the model.',
	inputSchema: z.object({
		datasetName: z.string().describe('Short identifier of the dataset.'),
		datasetDescription: z
			.string()
			.describe('Human-readable description of the dataset.'),
		schemaSummary: z
			.string()
			.describe(
				'Concise text summary of tables/columns that the planner already sees.'
			),
		dataRequest: z
			.string()
			.describe(
				'Natural-language description of the data needed. This tool will translate the request into a SQLite SELECT query internally.'
			),
	}),
	execute: async ({
		datasetName,
		datasetDescription,
		schemaSummary,
		dataRequest,
	}: {
		datasetName: string;
		datasetDescription: string;
		schemaSummary: string;
		dataRequest: string;
	}) => {
		ensureDataDir();

		// 1. Resolve DB path and ensure it exists.
		//    The database MUST have been downloaded during initialization
		//    (before the planner runs).
		const authoritativeDatasetName = datasetName;
		const dbPath = getDbPath(authoritativeDatasetName);

		if (!existsSync(dbPath)) {
			throw new Error(
				`[dataTool] Database file not found at ${dbPath}. It should be downloaded during initialization before invoking the planner.`
			);
		}

		// 2. Use LLM to build the SQL query from the natural-language dataRequest.
		const sqlResult = await sqlFromRequestGenerator({
			datasetDescription,
			schemaSummary,
			dataRequest,
		});
		const sql = sqlResult.text.trim();

		if (!sql) {
			throw new Error('[dataTool] SQL generator returned an empty query.');
		}

		console.log(`[dataTool] Executing SQL generated from natural-language request:\n${sql}\n`);

		// 3. Execute SQL against the local SQLite DB.
		const db = openReadonlyDatabase(dbPath);
		let rows: unknown[];
		try {
			rows = db.prepare(sql).all();
		} finally {
			db.close();
		}

		// 4. Persist full data to JSON file on disk.
		const pointId = dataPointCounter++;
		// const jsonFilename = `${authoritativeDatasetName}-point-${pointId}.json`;
		const dataKey = `${authoritativeDatasetName}_${pointId}`;

		// Store in memory instead of writing to file
		collectedData[dataKey] = rows;

		// 5. Build preview JSON according to truncation rules:
		//    - Show up to first 5 rows.
		//    - For arrays longer than 5, show only first 3 entries and then append "... N more items" text.
		let previewJson: string;

		if (!Array.isArray(rows)) {
			previewJson = JSON.stringify([rows], previewReplacer, 2);
		} else if (rows.length <= 5) {
			previewJson = JSON.stringify(rows, previewReplacer, 2);
		} else {
			const truncated = rows.slice(0, 3);
			const json = JSON.stringify(truncated, previewReplacer, 2);
			previewJson = json.replace(
				/\n\]$/,
				`,\n   ... ${rows.length - 3} more items\n]`
			);
		}

		return {
			dataFile: dataKey,
			previewJson,
		};
	},
});

// ---------------------------------------------------------------------------
// Planner LLM (Planning Agent)
// ---------------------------------------------------------------------------

const plannerAgent = create.TextGenerator.withTemplate({
	model: advancedModel,
	temperature: 0.2,
	tools: { dataTool },
	//maxSteps: 8,
	stopWhen: stepCountIs(32),
	prompt: `
You are a planning agent that designs interactive data dashboards.

You receive:
- datasetName: {{ datasetName }}
- datasetDescription: {{ datasetDescription }}
- userRequest: {{ userRequest }}
- schemaSummary:
{{ schemaSummary }}

Your job:
- Understand the user's dashboard request in the context of a specific SQLite dataset.
- Break the request into 4-7 dashboard elements (charts, tables, KPI cards, text, etc.).
- Decide which elements need data previews.
- For each element that needs data, call the "dataTool" exactly once with:
  - datasetName
  - datasetDescription
  - schemaSummary
  - dataRequest: a clear natural-language description of the data you want (never SQL).
- Use only the fields in the previewJson when later referring to data fields in descriptions.

Output:
- A single text block that follows the dashboard plan format EXACTLY as described below.
- Do NOT generate HTML, JavaScript, or SQL anywhere in the plan. The dataRequest field must be pure natural language; the tool will handle SQL generation internally.

Required dashboard plan format (you MUST follow this structure):

DASHBOARD PLAN
==============

Overall intent:
- <1–3 bullet points summarizing the user request>

Element 1
---------
id: <id string>
type: <chart|table|text|kpi|other>
layoutHint: <full-width|half-width|third-width|auto>
title: <short title>
description: <detailed description of what this element shows>
usesData: <yes|no>

# The following fields exist only when usesData=yes:
dataRequest: |
  <natural language description of the needed data>

dataFile: <data key returned by dataTool>

previewJson:
\`\`\`json
<preview JSON returned by dataTool>
\`\`\`

## Element 2

...same format...

## Element 3

...same format...

# Continue numbering Elements sequentially.

Rules:
- Number elements sequentially (Element 1, Element 2, Element 3, ...).
- At least one element MUST have usesData: yes and must actually call dataTool.
- All dataTool calls MUST pass a purely natural-language dataRequest. Do NOT include SQL keywords like SELECT, FROM, WHERE, GROUP BY, etc.
- Insert the exact dataFile and previewJson from the tool result into the corresponding element.
- IMPORTANT: The previewJson returned by the tool might contain truncation text (e.g. "... N more items") which makes it invalid JSON. You MUST copy this text EXACTLY as is, do not try to "fix" it or make it valid JSON.
- Do not output anything before "DASHBOARD PLAN" or after the last element.
`.trim(),
});

// ---------------------------------------------------------------------------
// Generator LLM (Dashboard HTML Body)
// ---------------------------------------------------------------------------

const generatorConfig = create.Config({
	model: basicModel,
	temperature: 0.4,
});

const dashboardBodyGenerator = create.TextGenerator.withTemplate(
	{
		prompt: `
You are a front-end engineer who turns high-level dashboard plans into HTML dashboards.

Your task:
- Read the dashboard plan and generate exactly ONE <body>...</body> element.
- Use Bootstrap 5 classes for layout (container, row, col-*, card, text utilities, spacing).
- Use Chart.js for charts.

You are given:
- datasetName: {{ datasetName }}
- datasetDescription: {{ datasetDescription }}
- userRequest: {{ userRequest }}

Schema summary (for context only):
{{ schemaSummary }}

Full dashboard plan (you must follow it):
{{ plan }}

Requirements for the generated HTML:

1) Overall structure
- Output a single <body>...</body> element and nothing else.
- Use a top-level <div class="container my-4"> as the main wrapper.
- Use Bootstrap rows and columns to arrange dashboard elements (full-width, half-width, third-width) based on the layoutHint in the plan.

2) Elements
- For each element in the plan:
  - If type=chart, create a <div style="position: relative; height: 300px; width: 100%;"><canvas></canvas></div> inside a Bootstrap card.
    - CRITICAL: The wrapper div with fixed height is REQUIRED to prevent Chart.js from entering an infinite resizing loop.
  - If type=table, create a <table class="table table-striped table-sm"> inside a card.
  - If type=text or kpi, create a card with appropriate headings and text.
- Use the title and description from the plan for each card.

3) Data fetching & Chart.js
- For each element with usesData: yes:
  - Use a <script> at the end of the body to:
    - Wrap ALL code in "document.addEventListener('DOMContentLoaded', () => { ... });" to ensure the data at the bottom of the file is loaded before execution.
    - Access the data via window.dashboardData[dataKey] (where dataKey is the 'dataFile' value from the plan).
    - Do NOT define window.dashboardData or include mock data. It is injected automatically by the system wrapper.
    - Process the resulting array of objects to build labels and datasets.
    - Use only field names that actually appear in the previewJson for that element.
    - Create a new Chart: new Chart(ctx, { type, data, options }).
- You may define small helper functions in JavaScript inside the <script> block to group/summarize data.

4) Styling & UX
- Use headings (e.g., <h1>, <h2>) to label the dashboard.
- Add small descriptive text under each card title describing what the user can see.
- Ensure the layout looks reasonable on both desktop and smaller screens using Bootstrap grid classes.

Important:
- Do NOT include <html>, <head>, <link>, or <script src="..."> tags for libraries.
- Do NOT include any mock data.
- Assume Bootstrap 5 CSS, Chart.js, and any helper scripts are already included by the outer wrapper.

Return only the <body>...</body> element.
`.trim(),
	},
	generatorConfig
);

// ---------------------------------------------------------------------------
// HTML wrapper template (via Cascada Template)
// ---------------------------------------------------------------------------

const dashboardTemplate = create.Template({
	template: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Generated Dashboard</title>
    <link
      href="https://cdn.jsdelivr.net/npm/bootstrap@5/dist/css/bootstrap.min.css"
      rel="stylesheet"
    />
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  </head>
  {{ body|safe }}
  {{ dataScript|safe }}
</html>`
});

// ---------------------------------------------------------------------------
// Script orchestration (plain JS)
// ---------------------------------------------------------------------------

async function wrapHtml(body: string): Promise<string> {
	const dataScript = `<script>window.dashboardData = ${JSON.stringify(collectedData)};</script>`;
	return await dashboardTemplate({ body, dataScript });
}

function writeDashboard(html: string): void {
	writeFileSync(OUTPUT_HTML, html, 'utf-8');
}

async function dashboardOrchestrator(): Promise<{
	outputFile?: string;
	plan?: string;
}> {
	console.log('Casai Planning Pattern Example: Dashboard Generator');

	// 1. Load input.json
	const input = await loadInput();
	console.log('Loaded input.json for dataset:', input.datasetName);
	console.log('User request:', input.userRequest);

	// 2. Ensure DB exists
	const dbPath = await downloadDatabaseIfMissing(
		input.datasetName,
		input.databaseUrl
	);

	// 3. Extract schema summary
	const schemaSummary = extractSchemaSummary(dbPath, input.datasetName);
	console.log('\n=== Schema Summary ===\n');
	console.log(schemaSummary);

	// 4. Run planner
	console.log('\nRunning planner LLM...\n');
	const planResult = await plannerAgent({
		datasetName: input.datasetName,
		datasetDescription: input.datasetDescription,
		userRequest: input.userRequest,
		schemaSummary,
	});
	const planText = planResult.text;

	if (!planText.trim().startsWith('DASHBOARD PLAN')) {
		console.log(
			"[WARN] Planner output does not start with 'DASHBOARD PLAN'. The generator will still attempt to use it."
		);
	}

	console.log('\n=== DASHBOARD PLAN ===\n');
	console.log(planText);

	// 5. Run generator
	console.log('\nRunning generator LLM...\n');
	const bodyResult = await dashboardBodyGenerator({
		datasetName: input.datasetName,
		datasetDescription: input.datasetDescription,
		userRequest: input.userRequest,
		schemaSummary,
		plan: planText,
	});
	const bodyHtml = bodyResult.text;

	// 6. Wrap and save final HTML
	const finalHtml = await wrapHtml(bodyHtml);
	writeDashboard(finalHtml);

	console.log('\nDashboard written to:', OUTPUT_HTML);

	// 7. Serve the dashboard
	console.log('Open this file in your browser to view the generated dashboard.');

	return {
		plan: planText,
		outputFile: 'dashboard.html',
	};
}

// ---------------------------------------------------------------------------
// Execution entrypoint
// ---------------------------------------------------------------------------

console.log('--- Dashboard Planning Example ---');
try {
	const result = await dashboardOrchestrator();
	console.log('\n--- Execution Complete ---');
	if (result.outputFile) {
		console.log(`Generated dashboard: ${OUTPUT_HTML}`);
	}
} catch (error) {
	console.error('Orchestration failed:', error);
}
