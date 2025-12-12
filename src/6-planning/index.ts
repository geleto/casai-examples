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

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { basicModel, advancedModel } from '../setup';
import { create, FileSystemLoader } from 'casai';
import Sqlite from 'better-sqlite3';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';

import inputJson from './input.json';
const input = inputJson as {
	userRequest: string;
	datasetName: string;
	datasetDescription: string;
	databaseUrl: string;
	port: number;
};
const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_HTML = path.join(BASE_DIR, 'dashboard.html');
const templateLoader = new FileSystemLoader(fileURLToPath(new URL('./templates', import.meta.url)));

// ---------------------------------------------------------------------------
// Database class
// ---------------------------------------------------------------------------
class Database {
	private db!: Sqlite.Database;

	constructor(
		readonly datasetName: string,
		readonly datasetDescription: string,
		readonly databaseUrl: string
	) { }

	// Loads the database if necessary and opens it
	async open() {
		const dataDir = path.join(BASE_DIR, 'database');
		if (!existsSync(dataDir)) {
			mkdirSync(dataDir, { recursive: true });
		}
		const dbPath = path.join(dataDir, `${this.datasetName}.db`);

		// Download database if it doesn't exist
		if (!existsSync(dbPath)) {
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
			await fs.writeFile(dbPath, buffer);
			console.log(`Saved DB to ${dbPath}`);
		}

		// Open the database (whether just downloaded or already existed)
		this.db = new Sqlite(dbPath, { readonly: true });
	}

	getDb(): Sqlite.Database {
		return this.db;
	}

	// Extracts a concise schema summary from the database. DB must be opened first.
	getSchemaSummary(): string {
		const db = this.getDb();
		const tables = db.prepare<[], { name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
		).all();

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

	close(): void {
		this.db.close();
	}
}

// LLM-powered SQL generator. Takes a natural-language data request plus
// schema/context and returns a single SQLite SELECT query as plain text.
const sqlFromRequestGenerator = create.TextGenerator.loadsTemplate({
	model: advancedModel,
	loader: templateLoader,
	prompt: 'sql-generator.md',
});

// ---------------------------------------------------------------------------
// Data Fetching Logic (formerly dataTool)
// ---------------------------------------------------------------------------
const collectedData: Record<string, unknown> = {};
let dataPointCounter = 1;

interface DashboardElement {
	id: string;
	type: 'chart' | 'table' | 'text' | 'kpi' | 'other';
	layoutHint: 'full-width' | 'half-width' | 'third-width' | 'auto';
	title: string;
	description: string;
	usesData: boolean;
	dataRequest?: string;
	dataFile?: string;
	previewJson?: string;
}

async function processDashboardElement(
	element: DashboardElement,
	database: Database,
	schemaSummary: string
): Promise<DashboardElement> {
	if (!element.usesData || !element.dataRequest) {
		return element;
	}

	// 1. Use LLM to build the SQL query from the natural-language dataRequest.
	const sqlResult = await sqlFromRequestGenerator({
		datasetDescription: database.datasetDescription,
		schemaSummary: schemaSummary,
		dataRequest: element.dataRequest,
	});
	const sql = sqlResult.text.trim();
	console.log(`[DataProcessing] Executing generated SQL for "${element.title}":\n${sql}\n`);

	// 2. Execute SQL against the local SQLite DB.
	const db = database.getDb();
	let rows: any[];
	try {
		rows = db.prepare(sql).all();
	} catch (err: unknown) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		console.error(`SQL Execution failed: ${errorMessage}`);
		rows = [];
	}

	// 3. Persist full data for later inline injection into dashboard.html.
	const pointId = dataPointCounter++;
	const dataKey = `${database.datasetName}_${pointId}`;
	collectedData[dataKey] = rows; // Store in memory

	// 4. Build preview JSON according to truncation rules:
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
		...element,
		dataFile: dataKey,
		previewJson,
	};
}

// ---------------------------------------------------------------------------
// Generator LLM (Dashboard HTML Body)
// ---------------------------------------------------------------------------
const dashboardBodyGenerator = create.TextGenerator.loadsTemplate({
	model: basicModel,
	loader: templateLoader,
	prompt: 'dashboard-generator.md',
});

// ---------------------------------------------------------------------------
// Cascada HTML wrappertemplate
// ---------------------------------------------------------------------------
const dashboardTemplate = create.Template.loadsTemplate({
	loader: templateLoader,
	template: 'dashboard-template.html',
});

const planTemplate = create.Template.loadsTemplate({
	loader: templateLoader,
	template: 'dashboard-plan-template.md',
});

// ---------------------------------------------------------------------------
// Script orchestration
// ---------------------------------------------------------------------------
async function dashboardOrchestrator(): Promise<{ outputFile?: string; plan?: string; }> {
	console.log('Casai Planning Pattern Example: Dashboard Generator');
	console.log(`User request: ${input.userRequest}\n Dataset: ${input.datasetName}`);

	// 1. Initialize database
	const database = new Database(input.datasetName, input.datasetDescription, input.databaseUrl);
	try {
		// 2. Ensure DB is downloaded and open it
		await database.open();

		// 3. Extract schema summary
		const schemaSummary = database.getSchemaSummary();
		console.log(`\n=== Schema Summary ===\n${schemaSummary}`);

		// 5. Run planner with structured output
		console.log('\nRunning planner LLM (Structured Output)...\n');
		const plannerAgent = create.ObjectGenerator.loadsTemplate({
			model: advancedModel,
			loader: templateLoader,
			prompt: 'planner-agent.md',
			output: 'array',
			schema: z.object({
				id: z.string(),
				type: z.enum(['chart', 'table', 'text', 'kpi', 'other']),
				layoutHint: z.enum(['full-width', 'half-width', 'third-width', 'auto']),
				title: z.string(),
				description: z.string(),
				usesData: z.boolean(),
				dataRequest: z.string().optional().describe('Natural language description of needed data'),
			}),
		});

		const planResult = await plannerAgent({
			datasetName: input.datasetName,
			datasetDescription: input.datasetDescription,
			userRequest: input.userRequest,
			schemaSummary,
		});

		const elements = planResult.object;
		console.log(`\nPlanner returned ${elements.length} elements. Processing data requests...`);

		// 6. Process elements (fetch data)
		const processedElements = [];
		for (const element of elements) {
			processedElements.push(await processDashboardElement(element, database, schemaSummary));
		}

		// 7. Generate Plan Text using Template
		const overallIntent = `- User Request: ${input.userRequest}`;

		const elementsText = processedElements.map((el, idx) => {
			let text = `Element ${idx + 1}\n---------\n`;
			text += `id: ${el.id}\n`;
			text += `type: ${el.type}\n`;
			text += `layoutHint: ${el.layoutHint}\n`;
			text += `title: ${el.title}\n`;
			text += `description: ${el.description}\n`;
			text += `usesData: ${el.usesData ? 'yes' : 'no'}\n`;

			if (el.usesData) {
				text += `\ndataRequest: |\n  ${el.dataRequest}\n\n`;
				text += `dataFile: ${el.dataFile}\n\n`;
				text += `previewJson:\n\`\`\`json\n${el.previewJson}\n\`\`\`\n`;
			}
			return text;
		}).join('\n');

		const planText = await planTemplate({
			overallIntent,
			elementsText
		});

		console.log(`\n=== DASHBOARD PLAN ===\n${planText}`);

		// 6. Run generator
		console.log('\nRunning generator LLM...\n');
		const bodyResult = await dashboardBodyGenerator({
			datasetName: input.datasetName,
			datasetDescription: input.datasetDescription,
			userRequest: input.userRequest,
			schemaSummary,
			plan: planText,
		});
		const bodyHtml = bodyResult.text;

		// 7. Wrap and save final HTML
		const dataScript = `<script>window.dashboardData = ${JSON.stringify(collectedData)};</script>`;
		const finalHtml = await dashboardTemplate({ bodyHtml, dataScript });
		writeFileSync(OUTPUT_HTML, finalHtml, 'utf-8');

		console.log('\nDashboard written to:', OUTPUT_HTML);

		// 7. Serve the dashboard
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