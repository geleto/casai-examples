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

const OUTPUT_HTML = path.join(__dirname, 'dashboard.html');
const TEMPLATES_DIR = fileURLToPath(new URL('./templates', import.meta.url));

const templateLoader = new FileSystemLoader(TEMPLATES_DIR);

// ---------------------------------------------------------------------------
// Database class
// ---------------------------------------------------------------------------

class Database {
	private dbPath: string | null = null;
	private db: Sqlite.Database | null = null;

	constructor(
		readonly datasetName: string,
		readonly datasetDescription: string,
		readonly databaseUrl: string
	) {
		// Constructor just initializes the instance
		// Database will be opened via open() method
	}

	/**
	 * Loads the database if necessary and opens it
	 */
	async open() {
		// If already opened, return early
		if (this.db) {
			return;
		}

		const dataDir = path.join(__dirname, 'database');
		if (!existsSync(dataDir)) {
			mkdirSync(dataDir, { recursive: true });
		}
		this.dbPath = path.join(dataDir, `${this.datasetName}.db`);

		// Download database if it doesn't exist
		if (!existsSync(this.dbPath)) {
			console.log(
				`Downloading SQLite DB for dataset "${this.datasetName}" from ${this.databaseUrl}...`
			);
			const response = await fetch(this.databaseUrl);
			if (!response.ok) {
				throw new Error(
					`Failed to download DB from ${this.databaseUrl}. HTTP ${response.status} ${response.statusText}`
				);
			}
			const arrayBuffer = await response.arrayBuffer();
			const buffer = Buffer.from(arrayBuffer);
			await fs.writeFile(this.dbPath, buffer);
			console.log(`Saved DB to ${this.dbPath}`);
		}

		// Open the database (whether just downloaded or already existed)
		this.db = new Sqlite(this.dbPath, { readonly: true });
	}

	getDb(): Sqlite.Database {
		if (!this.db) {
			throw new Error('Database not opened. Call open() first.');
		}
		return this.db;
	}

	/**
	 * Extracts a concise schema summary from the database.
	 * Database must be opened first.
	 */
	getSchemaSummary(): string {
		const db = this.getDb();
		const tables = db
			.prepare<[], { name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
			)
			.all();

		interface TableInfo {
			name: string;
			type: string | null;
			pk: 0 | 1;
		}

		const lines: string[] = [];
		lines.push(`Dataset: ${this.datasetName}`);
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

	/**
	 * Closes the database connection.
	 */
	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}
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

/**
 * Creates a dataTool instance bound to a specific Database instance.
 */
function createDataTool(database: Database, schemaSummary: string) {
	return create.Function.asTool({
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
			datasetName: database.datasetName,
			datasetDescription: database.datasetDescription,
			schemaSummary,
		},
		// parameters combine the context and the input schema
		execute: async (parameters) => {
			// 1. Use LLM to build the SQL query from the natural-language dataRequest.
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

			// 2. Execute SQL against the local SQLite DB.
			const db = database.getDb();
			const rows = db.prepare(sql).all();

			// 3. Persist full data to JSON file on disk.
			const pointId = dataPointCounter++;
			const dataKey = `${parameters.datasetName}_${pointId}`;

			// Store in memory instead of writing to file
			collectedData[dataKey] = rows;

			// 4. Build preview JSON according to truncation rules:
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
}



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

	// 2. Initialize database
	const database = new Database(
		input.datasetName,
		input.datasetDescription,
		input.databaseUrl
	);

	// 3. Ensure DB is downloaded and open it
	await database.open();

	try {
		// 4. Extract schema summary
		const schemaSummary = database.getSchemaSummary();
		console.log('\n=== Schema Summary ===\n');
		console.log(schemaSummary);

		// 5. Create dataTool bound to this database instance
		const dataTool = createDataTool(database, schemaSummary);

		// 6. Run planner
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

		// 7. Run generator
		console.log('\nRunning generator LLM...\n');
		const bodyResult = await dashboardBodyGenerator({
			datasetName: input.datasetName,
			datasetDescription: input.datasetDescription,
			userRequest: input.userRequest,
			schemaSummary,
			plan: planText,
		});
		const bodyHtml = bodyResult.text;

		// 8. Wrap and save final HTML
		const finalHtml = await wrapHtml(bodyHtml);
		writeFileSync(OUTPUT_HTML, finalHtml, 'utf-8');

		console.log('\nDashboard written to:', OUTPUT_HTML);

		// 9. Serve the dashboard
		console.log('Open this file in your browser to view the generated dashboard.');

		return {
			plan: planText,
			outputFile: 'dashboard.html',
		};
	} finally {
		database.close();
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
