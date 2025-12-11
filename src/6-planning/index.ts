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
import Sqlite from 'better-sqlite3';
import fs from 'fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stepCountIs } from 'ai';
import inputJson from './input.json';

const input = inputJson as {
	userRequest: string;
	datasetName: string;
	datasetDescription: string;
	databaseUrl: string;
	port: number;
};

// ---------------------------------------------------------------------------
// Types & paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = path.join(__dirname, 'database');
const OUTPUT_HTML = path.join(__dirname, 'dashboard.html');
const TEMPLATES_DIR = fileURLToPath(new URL('./templates', import.meta.url));

const templateLoader = new FileSystemLoader(TEMPLATES_DIR);

// Global DB instance
let db!: Sqlite.Database;

/**
 * Download the SQLite DB to ./database/<datasetName>.db if it does not exist yet.
 */
async function downloadDatabaseIfMissing(
	datasetName: string,
	databaseUrl: string
): Promise<string> {
	if (!existsSync(DATA_DIR)) {
		mkdirSync(DATA_DIR, { recursive: true });
	}
	const dbPath = path.join(DATA_DIR, `${datasetName}.db`);

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
// Schema extraction (LLM-friendly summary from SQLite metadata)
// ---------------------------------------------------------------------------

interface TableInfo {
	name: string;
	type: string | null;
	pk: 0 | 1;
}

function extractSchemaSummary(datasetName: string): string {
	const tables = db
		.prepare<[], { name: string }>(
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
			.prepare<[], TableInfo>(`PRAGMA table_info("${escaped}")`)
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
}

// ---------------------------------------------------------------------------
// dataTool implementation
// ---------------------------------------------------------------------------

const collectedData: Record<string, unknown> = {};
let dataPointCounter = 1;

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
		dataRequest: z
			.string()
			.describe(
				'Natural-language description of the data needed. This tool will translate the request into a SQLite SELECT query internally.'
			),
	}),
	context: {
		datasetName: input.datasetName,
		datasetDescription: input.datasetDescription,
		schemaSummary: input.schemaSummary,
	},
	// parameters combine the context and the input schema
	execute: async (parameters) => {
		if (!existsSync(DATA_DIR)) {
			mkdirSync(DATA_DIR, { recursive: true });
		}

		// 1. Resolve DB path.
		// We use the authoritative datasetName from the outer scope, so no hallucination possible.
		// const dbPath = getDbPath(context.datasetName); // Unused

		// 2. Use LLM to build the SQL query from the natural-language dataRequest.
		const sqlResult = await sqlFromRequestGenerator({
			datasetDescription: parameters.datasetDescription,
			schemaSummary: parameters.schemaSummary,
			dataRequest: parameters.dataRequest,
		});
		const sql = sqlResult.text.trim();

		if (!sql) {
			throw new Error('[dataTool] SQL generator returned an empty query.');
		}

		console.log(
			`[dataTool] Executing SQL generated from natural-language request:\n${sql}\n`
		);

		// 3. Execute SQL against the local SQLite DB.
		// Used global db
		const rows = db.prepare(sql).all();

		// 4. Persist full data to JSON file on disk.
		const pointId = dataPointCounter++;
		const dataKey = `${parameters.datasetName}_${pointId}`;

		// Store in memory instead of writing to file
		collectedData[dataKey] = rows;

		// 5. Build preview JSON according to truncation rules:
		//    - Show up to first 5 rows.
		//    - For arrays longer than 5, show only first 3 entries and then append "... N more items" text.
		let previewJson: string;

		if (!Array.isArray(rows)) {
			previewJson = JSON.stringify([rows], null, 2);
		} else if (rows.length <= 5) {
			previewJson = JSON.stringify(rows, null, 2);
		} else {
			const truncated = rows.slice(0, 3);
			const json = JSON.stringify(truncated, null, 2);
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

// writeDashboard inlined


async function dashboardOrchestrator(): Promise<{
	outputFile?: string;
	plan?: string;
}> {
	console.log('Casai Planning Pattern Example: Dashboard Generator');

	// 1. Load input.json
	// Input is imported directly

	console.log('Loaded input.json for dataset:', input.datasetName);
	console.log('User request:', input.userRequest);

	// 2. Ensure DB exists
	const dbPath = await downloadDatabaseIfMissing(
		input.datasetName,
		input.databaseUrl
	);

	// Initialize global DB
	db = new Sqlite(dbPath, { readonly: true });

	try {
		// 3. Extract schema summary
		const schemaSummary = extractSchemaSummary(input.datasetName);
		console.log('\n=== Schema Summary ===\n');
		console.log(schemaSummary);

		// 4. Run planner
		console.log('\nRunning planner LLM...\n');

		const plannerAgent = create.TextGenerator.loadsTemplate({
			model: advancedModel,
			temperature: 0.2,
			tools: { dataTool },
			stopWhen: stepCountIs(32),
			loader: templateLoader,
			prompt: 'planner-agent.md',
		});

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
		writeFileSync(OUTPUT_HTML, finalHtml, 'utf-8');

		console.log('\nDashboard written to:', OUTPUT_HTML);

		// 7. Serve the dashboard
		console.log('Open this file in your browser to view the generated dashboard.');

		return {
			plan: planText,
			outputFile: 'dashboard.html',
		};
	} finally {
		db.close();
	}
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
