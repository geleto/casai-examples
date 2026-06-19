/**
 * PLANNING PATTERN EXAMPLE: DASHBOARD GENERATOR
 *
 * Demonstrates an AI agent that creates a data dashboard by first planning the layout and data requirements, then executing that plan.
 *
 * HOW IT WORKS:
 * 1. Generate a schema summary by inspecting the SQLite database
 * 2. Analyze the user request and schema to plan the dashboard
 * 3. Planner Agent generates a structured list of dashboard elements (charts, KPIs)
 * 4. For each element, generate and execute SQL to fetch the necessary data
 * 5. Insight elements are converted into concise data-backed HTML
 * 6. Generator Agent creates the HTML visualization using the plan and data
 * 7. Assemble the final dashboard with Bootstrap and Chart.js
 *
 * KEY CONCEPTS:
 * - Planning Pattern: Break complex tasks into structured steps
 * - Tool Use: Dynamic SQL generation and database querying
 * - Structured Output: Using Zod schemas to enforce plan format
 * - Concurrency: SQL generation and data fetching for elements run in parallel
 * - Multi-step Chaining: Planner, data fetcher, and code generator
 */

import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
import { basicModel, advancedModel, providerOptions } from '../setup';
import { create, FileSystemLoader, z } from 'casai';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import { Database } from './Database';

import inputJson from './input.json';
interface PlanningInput {
	userRequest: string;
	datasetName: string;
	datasetDescription: string;
	databaseUrl: string;
	port: number;
}
const input: PlanningInput = inputJson;

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_HTML = path.join(BASE_DIR, 'dashboard.html');
const templateLoader = new FileSystemLoader(fileURLToPath(new URL('./templates', import.meta.url)));

function openInBrowser(url: string): void {
	const command = process.platform === 'win32'
		? 'cmd'
		: process.platform === 'darwin' ? 'open' : 'xdg-open';
	const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
	const child = spawn(command, args, {
		detached: true, stdio: 'ignore', windowsHide: true,
	});
	child.on('error', (error) => {
		console.warn(`Could not open dashboard automatically: ${error.message}`);
	});
	child.unref();
}

const collectedData: Record<string, unknown> = {};
let dataPointCounter = 1;

const dashboardElementSchema = z.object({
	id: z.string().describe('Unique identifier for the element'),
	type: z.enum(['chart', 'table', 'text', 'insight', 'kpi', 'other']).describe('Type of dashboard element'),
	layoutHint: z.enum(['full-width', 'half-width', 'third-width', 'auto']).describe('Suggested layout width'),
	title: z.string().describe('Display title for the element'),
	description: z.string().describe('Brief description of what this element shows'),
	usesData: z.boolean().describe('Whether this element requires data fetching'),
	dataRequest: z.string().optional().describe('Natural language description of needed data (if usesData is true)'),
});

type DashboardElement = z.infer<typeof dashboardElementSchema> & {
	dataFile?: string;
	previewJson?: string;
	contentHtml?: string;
};

// ---------------------------------------------------------------------------
// Planner LLM - Generate dashboard plan
// ---------------------------------------------------------------------------
const plannerAgent = create.ObjectGenerator.loadsTemplate({
	model: advancedModel,
	providerOptions,
	loader: templateLoader,
	prompt: 'planner-agent.md',
	output: 'array',
	schema: dashboardElementSchema,
});

// ---------------------------------------------------------------------------
// LLM-powered SQL generator. Takes a natural-language data request plus
// schema/context and returns a single SQLite SELECT query as plain text.
// ---------------------------------------------------------------------------
const sqlFromRequestGenerator = create.TextGenerator.loadsTemplate({
	model: advancedModel,
	providerOptions,
	loader: templateLoader,
	prompt: 'sql-generator.md',
});

const textInsightGenerator = create.TextGenerator.loadsTemplate({
	model: advancedModel,
	providerOptions,
	loader: templateLoader,
	prompt: 'text-insight-generator.md',
});

// ---------------------------------------------------------------------------
// Generator LLM prompt - generate HTML body
// ---------------------------------------------------------------------------
const dashboardBodyGenerator = create.TextGenerator.loadsTemplate({
	model: basicModel,
	providerOptions,
	loader: templateLoader,
	prompt: 'dashboard-generator.md',
});

// ---------------------------------------------------------------------------
// Cascada HTML/test wrapper templates
// ---------------------------------------------------------------------------
const dashboardTemplate = create.Template.loadsTemplate({
	loader: templateLoader,
	template: 'dashboard-template.html',
});

const planTemplate = create.Template.loadsTemplate({
	loader: templateLoader,
	template: 'dashboard-plan-template.md',
});

const schemaSummaryTemplate = create.Template.loadsTemplate({
	loader: templateLoader,
	template: 'schema-summary.txt',
});

// ---------------------------------------------------------------------------
// For each data dashboard element - add relevant data from the database
// ---------------------------------------------------------------------------
const elementProcessor = create.Script({
	context: {
		sqlFromRequestGenerator,
		textInsightGenerator,
		executeSql: (sql: string, database: Database) => {
			return database.executeSql(sql);
		},
		generatePreviewJson: (rows: any[], rowLimit = 5) => {
			if (!Array.isArray(rows)) {
				return JSON.stringify([rows], null, 2);
			} else if (rows.length <= rowLimit) {
				return JSON.stringify(rows, null, 2);
			} else {
				const truncated = rows.slice(0, rowLimit);
				const json = JSON.stringify(truncated, null, 2);
				return json.replace(
					/\n\]$/,
					`,\n   ... ${rows.length - rowLimit} more items\n]`
				);
			}
		},
		saveData: (rows: any[], database: Database) => {
			const dataKey = `${database.datasetName}_${dataPointCounter++}`;
			collectedData[dataKey] = rows;
			return dataKey;
		},
		datasetDescription: input.datasetDescription,
		datasetName: input.datasetName,
		userRequest: input.userRequest,
	},
	schema: z.array(dashboardElementSchema.extend({
		dataFile: z.string().optional(),
		previewJson: z.string().optional(),
		contentHtml: z.string().optional(),
	})),
	script: `
		data processedElements = []
		for element in elements
			if element.usesData and element.dataRequest
				var sqlResult = sqlFromRequestGenerator({
					datasetDescription: datasetDescription,
					schemaSummary: schemaSummary,
					elementType: element.type,
					dataRequest: element.dataRequest
				}).text
				var rows = executeSql(sqlResult, database)
				element.previewJson = generatePreviewJson(rows)
				element.dataFile = saveData(rows, database)
				if element.type == "insight"
					element.contentHtml = textInsightGenerator({
						datasetName: datasetName,
						datasetDescription: datasetDescription,
						userRequest: userRequest,
						title: element.title,
						description: element.description,
						dataRequest: element.dataRequest,
						jsonExcerpt: generatePreviewJson(rows, 25)
					}).text
				endif
			endif
			processedElements.push(element)
		endfor
		return processedElements.snapshot()`
});

// ---------------------------------------------------------------------------
// Execution entrypoint
// ---------------------------------------------------------------------------
console.log('PLANNING PATTERN EXAMPLE\nDemonstrates an AI agent that creates a data dashboard by first planning the layout and data requirements, then executing that plan.\n');
console.log(`User request: ${input.userRequest}\n Dataset: ${input.datasetName}`);

// 1. Initialize database
const database = new Database(input.datasetName, input.datasetDescription, input.databaseUrl);
try {
	// 2. Ensure DB is downloaded and open it
	await database.open();

	// 3. Extract schema summary
	const schemaMetadata = database.getSchemaMetadata();
	const schemaSummary = await schemaSummaryTemplate(schemaMetadata);
	console.log(`\n=== Schema Summary ===\n${schemaSummary}`);

	// 5. Run planner with structured output
	console.log('\nRunning planner LLM (Structured Output)...\n');
	const planResult = await plannerAgent({
		datasetName: input.datasetName,
		datasetDescription: input.datasetDescription,
		userRequest: input.userRequest,
		schemaSummary,
	});
	const elements = planResult.object;
	console.log(`\nPlanner returned ${elements.length} elements. Processing data requests...`);

	// 6. Process elements (fetch data) using Cascada Script for concurrency
	const processedElements = await elementProcessor({ elements, database, schemaSummary }) as DashboardElement[];

	// 7. Generate Plan Text using Template
	const overallIntent = `- User Request: ${input.userRequest}`;
	const planText = await planTemplate({
		overallIntent,
		elements: processedElements
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
	const dashboardUrl = pathToFileURL(OUTPUT_HTML).href;
	console.log('\nDashboard written to:', OUTPUT_HTML);
	console.log('Dashboard URL:', dashboardUrl);
	openInBrowser(dashboardUrl);

	console.log('\n--- Dashboard generation complete ---');
	console.log(`Generated dashboard: ${dashboardUrl}`);

} catch (error) {
	console.error('Dashboard generation failed:', error);
} finally {
	database.close();
}