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
 * 5. Generator Agent creates the HTML visualization using the plan and data
 * 6. Assemble the final dashboard with Bootstrap and Chart.js
 *
 * KEY CONCEPTS:
 * - Planning Pattern: Break complex tasks into structured steps
 * - Tool Use: Dynamic SQL generation and database querying
 * - Structured Output: Using Zod schemas to enforce plan format
 * - Concurrency: SQL generation and data fetching for elements run in parallel
 * - Multi-step Chaining: Planner, data fetcher, and code generator
 */

import { writeFileSync } from 'fs';
import { basicModel, advancedModel } from '../setup';
import { create, FileSystemLoader, z } from 'casai';
import { fileURLToPath } from 'url';
import path from 'path';
import { Database } from './Database';

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

const collectedData: Record<string, unknown> = {};
let dataPointCounter = 1;

const dashboardElementSchema = z.object({
	id: z.string().describe('Unique identifier for the element'),
	type: z.enum(['chart', 'table', 'text', 'kpi', 'other']).describe('Type of dashboard element'),
	layoutHint: z.enum(['full-width', 'half-width', 'third-width', 'auto']).describe('Suggested layout width'),
	title: z.string().describe('Display title for the element'),
	description: z.string().describe('Brief description of what this element shows'),
	usesData: z.boolean().describe('Whether this element requires data fetching'),
	dataRequest: z.string().optional().describe('Natural language description of needed data (if usesData is true)'),
});

type DashboardElement = z.infer<typeof dashboardElementSchema> & {
	dataFile?: string;
	previewJson?: string;
};

// ---------------------------------------------------------------------------
// Planner LLM - Generate dashboard plan
// ---------------------------------------------------------------------------
const plannerAgent = create.ObjectGenerator.loadsTemplate({
	model: advancedModel,
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
	loader: templateLoader,
	prompt: 'sql-generator.md',
});

// ---------------------------------------------------------------------------
// Generator LLM prompt - generate HTML body
// ---------------------------------------------------------------------------
const dashboardBodyGenerator = create.TextGenerator.loadsTemplate({
	model: basicModel,
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
		executeSql: (sql: string, database: Database) => {
			return database.executeSql(sql);
		},
		generatePreviewJson: (rows: any[]) => {
			if (!Array.isArray(rows)) {
				return JSON.stringify([rows], null, 2);
			} else if (rows.length <= 5) {
				return JSON.stringify(rows, null, 2);
			} else {
				const truncated = rows.slice(0, 3);
				const json = JSON.stringify(truncated, null, 2);
				return json.replace(
					/\n\]$/,
					`,\n   ... ${rows.length - 3} more items\n]`
				);
			}
		},
		saveData: (rows: any[], database: Database) => {
			const pointId = dataPointCounter++;
			const dataKey = `${database.datasetName}_${pointId}`;
			collectedData[dataKey] = rows;
			return dataKey;
		},
		datasetDescription: input.datasetDescription,
	},
	schema: z.array(dashboardElementSchema.extend({
		dataFile: z.string().optional(),
		previewJson: z.string().optional(),
	})),
	script: `
		data processedElements
		processedElements = []
		for element in elements
			var processedElement = element
			if element.usesData and element.dataRequest
				var sqlResult = sqlFromRequestGenerator({
					datasetDescription: datasetDescription,
					schemaSummary: schemaSummary,
					dataRequest: element.dataRequest
				}).text
				var rows = executeSql(sqlResult, database)
				processedElement.previewJson = generatePreviewJson(rows)
				processedElement.dataFile = saveData(rows, database)
			endif
			processedElements.push(processedElement)
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
	const processedElements = (await elementProcessor({ elements, database, schemaSummary })) as unknown as DashboardElement[];

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
	console.log('\nDashboard written to:', OUTPUT_HTML);
	console.log('Open this file in your browser to view the generated dashboard.');

	console.log('\n--- Dashboard generation complete ---');
	console.log(`Generated dashboard: ${OUTPUT_HTML}`);

} catch (error) {
	console.error('Dashboard generation fasiled:', error);
} finally {
	database.close();
}
