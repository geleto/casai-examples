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

import { create, FileSystemLoader } from 'casai';
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

const templatesDir = fileURLToPath(new URL('./templates', import.meta.url));
const templateLoader = new FileSystemLoader(templatesDir);

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
const sqlFromRequestGenerator = create.TextGenerator.loadsTemplate({
	model: advancedModel,
	temperature: 0,
	loader: templateLoader,
	prompt: 'sql-generator.md',
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

const plannerAgent = create.TextGenerator.loadsTemplate({
	model: advancedModel,
	temperature: 0.2,
	tools: { dataTool },
	//maxSteps: 8,
	stopWhen: stepCountIs(32),
	loader: templateLoader,
	prompt: 'planner-agent.md',
});

// ---------------------------------------------------------------------------
// Generator LLM (Dashboard HTML Body)
// ---------------------------------------------------------------------------

const generatorConfig = create.Config({
	model: basicModel,
	temperature: 0.4,
});

const dashboardBodyGenerator = create.TextGenerator.loadsTemplate(
	{
		loader: templateLoader,
		prompt: 'dashboard-generator.md',
	},
	generatorConfig
);

// ---------------------------------------------------------------------------
// HTML wrapper template (via Cascada Template)
// ---------------------------------------------------------------------------

const dashboardTemplate = create.Template.loadsTemplate({
	loader: templateLoader,
	template: 'dashboard-template.html',
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
