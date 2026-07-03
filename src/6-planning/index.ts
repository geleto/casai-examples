/**
 * EXAMPLE 6 - FROM A PLAIN-ENGLISH QUESTION TO A FULL DASHBOARD
 *
 * Give the agent a plain-English request ("help me improve our sales") and a
 * SQLite database, and it builds a full interactive HTML dashboard - metrics,
 * charts, tables, and written insights. It plans what to show, then executes
 * that plan card by card. The job is split into small steps, each handed to the
 * cheapest model that can do it, and independent steps run concurrently - the
 * whole dashboard is roughly 50k tokens, 2-3 cents, and about 15 seconds.
 *
 * STEPS (see orchestrator.cas for the flow):
 * 1. Summarize the schema (no AI) - inspect the SQLite DB into a compact summary
 *    that grounds every prompt
 * 2. Plan the layout - three planners run in parallel (header+metrics,
 *    charts+tables, insights+text) and stream cards as they decide them
 * 3. Process each card as it streams - for a data card: narrow the schema to the
 *    tables it needs, generate and run SQL, repair a failed/empty query
 *    (escalate the model, then widen the schema), and for insight cards write the
 *    takeaway; every card is then rendered into an HTML/JS fragment
 * 4. Compose the page (no AI) - deterministic TypeScript arranges the fragments
 *    and adds shared helpers/data
 *
 * KEY IDEAS:
 * - Concurrent by default: Cascada runs independent planners, queries, and
 *   renders at the same time (~6-7 prompts in flight) with no async plumbing
 * - Cheap-first models: a cheap model drafts SQL and renders HTML; a stronger
 *   model only plans, repairs SQL, and writes insights
 * - Tool-style execution: the LLM writes the SQL, the database runs it
 * - Repair loop + progressive fallback: retry failed/empty queries, then degrade
 *   gracefully with an error note instead of breaking the page
 * - Structured output: Zod schemas keep planned and rendered cards typed
 * - Orchestration: the whole flow is one small Cascada script (orchestrator.cas)
 */

import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
import { basicModel, advancedModel, providerOptions } from '../setup';
import { create, FileSystemLoader } from 'casai';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import { createSchemaMetadataForTables, Database } from './Database';
import { schemas } from './types';
import type { types } from './types';

import inputJson from './input.json';
const inputFile: types.PlanningInputFile = inputJson;
const input = inputFile.scenarios[inputFile.activeScenario];
if (!input) {
	throw new Error(`input.json activeScenario "${inputFile.activeScenario}" was not found.`);
}

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_HTML = path.join(BASE_DIR, 'dashboard.html');
const templateLoader = new FileSystemLoader(fileURLToPath(new URL('./templates', import.meta.url)));
const scriptLoader = new FileSystemLoader(BASE_DIR);

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

const layoutPriority = {
	header: 0, metric: 1, chart: 2, table: 3, insight: 4, text: 5, other: 6,
};

function columnClass(element: types.ProcessedElement, metricIndex: number, metricCount: number, contentIndex: number, contentCount: number): string {
	const isLastOddContentItem = element.type != 'metric' && contentIndex == contentCount - 1 && (contentCount - 1) % 2 == 1;
	const isFullWidth = element.type == 'header' || (element.type != 'metric' && (contentIndex == 0 || isLastOddContentItem));
	const isHalfWidth = element.type != 'metric' || metricCount == 2 || metricCount == 4 || (metricCount == 5 && metricIndex < 2);
	if (isFullWidth) return 'col-12';
	if (isHalfWidth) return 'col-12 col-md-6';
	return metricCount > 5 ? 'col-12 col-md-6 col-xl-4' : 'col-12 col-md-4';
}

function layoutElements(elements: types.ProcessedElement[]): types.LayoutElement[] {
	const metricCount = elements.filter(element => element.type == 'metric').length;
	const contentCount = elements.filter(element => element.type != 'header' && element.type != 'metric').length;
	let metricIndex = 0, contentIndex = 0;
	return [...elements]
		.sort((a, b) => layoutPriority[a.type] - layoutPriority[b.type])
		.map(element => {
			const column = columnClass(element, metricIndex, metricCount, contentIndex, contentCount);
			if (element.type == 'metric') metricIndex++;
			else if (element.type != 'header') contentIndex++;
			return {
				...element,
				columnClass: column,
			};
		});
}

function normalizeElementId(type: string, id: string): string {
	return `${type}-${id}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

// ---------------------------------------------------------------------------
// Planner LLMs - stream independent sections of the dashboard plan.
// ---------------------------------------------------------------------------
const plannerConfig = create.Config({
	model: advancedModel,
	providerOptions,
	loader: templateLoader,
	output: 'array',
});

const headerMetricPlanner = create.ObjectStreamer.loadsTemplate({
	prompt: 'header-metric-planner.md',
	schema: schemas.headerMetricElement,
}, plannerConfig);

const visualPlanner = create.ObjectStreamer.loadsTemplate({
	prompt: 'visual-planner.md',
	schema: schemas.visualElement,
}, plannerConfig);

const insightTextPlanner = create.ObjectStreamer.loadsTemplate({
	prompt: 'insight-text-planner.md',
	schema: schemas.insightTextElement,
}, plannerConfig);

// ---------------------------------------------------------------------------
// SQL generator - tries a cheap first draft, then repairs with the advanced model if needed.
// ---------------------------------------------------------------------------
const sqlFromRequestGenerator = create.TextGenerator.loadsTemplate({
	model: basicModel,
	providerOptions,
	loader: templateLoader,
	prompt: 'sql-generator.md',
});

const sqlRepairGenerator = create.TextGenerator.loadsTemplate({
	model: advancedModel,
	providerOptions,
	loader: templateLoader,
	prompt: 'sql-repair-generator.md',
});

// ---------------------------------------------------------------------------
// Insight generator - turns query results into data-backed HTML text.
// ---------------------------------------------------------------------------
const textInsightGenerator = create.TextGenerator.loadsTemplate({
	model: advancedModel,
	providerOptions,
	loader: templateLoader,
	prompt: 'text-insight-generator.md',
});

// ---------------------------------------------------------------------------
// Element renderer - renders one enriched element into HTML and JS.
// ---------------------------------------------------------------------------
const elementRenderer = create.ObjectGenerator.loadsTemplate({
	model: basicModel,
	providerOptions,
	loader: templateLoader,
	prompt: 'element-renderer.md',
	output: 'object',
	schema: schemas.renderedElement,
});

// ---------------------------------------------------------------------------
// Templates - wrap the dashboard and summarize the DB schema.
// ---------------------------------------------------------------------------
const dashboardTemplate = create.Template.loadsTemplate({
	loader: templateLoader,
	template: 'dashboard-template.html',
});

const schemaSummaryTemplate = create.Template.loadsTemplate({
	loader: templateLoader,
	template: 'schema-summary.txt',
});

// ---------------------------------------------------------------------------
// Dashboard processor - plans sections in parallel, fetches data, and renders cards.
// ---------------------------------------------------------------------------
const dashboardProcessor = create.Script.loadsScript({
	loader: scriptLoader,
	context: {
		headerMetricPlanner,
		visualPlanner,
		insightTextPlanner,
		sqlFromRequestGenerator,
		sqlRepairGenerator,
		textInsightGenerator,
		elementRenderer,
		schemaSummaryTemplate,
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
		toJson: (value: unknown) => JSON.stringify(value, null, 2),
		normalizeElementId,
		datasetDescription: input.datasetDescription,
		datasetName: input.datasetName,
		userRequest: input.userRequest,
	},
	schema: schemas.processedDashboard,
	script: 'orchestrator.cas'
});

console.log('PLANNING PATTERN EXAMPLE\nDemonstrates an AI agent that creates a data dashboard by first planning the layout and data requirements, then executing that plan.\n');
console.log(`Scenario "${inputFile.activeScenario}": ${input.name}`);
console.log(`User request: ${input.userRequest}\n Dataset: ${input.datasetName}`);

// 1. Initialize database
const database = new Database(input.datasetName, input.datasetDescription, input.databaseUrl);
try {
	// 2. Ensure DB is downloaded and open it
	await database.open();

	// 3. Extract schema summary
	const schemaMetadata = database.getSchemaMetadata();
	const schemaSummary = await schemaSummaryTemplate(schemaMetadata);
	const schemaMetadataForTables = createSchemaMetadataForTables(schemaMetadata);
	console.log(`\n=== Schema Summary ===\n${schemaSummary}`);

	// 4. Plan sections, fetch data, generate insights, and render each card
	console.log('\nRunning planner sections and processing elements...\n');
	const elements = await dashboardProcessor({ database, schemaSummary, schemaMetadataForTables });
	if (elements[0]?.type != 'header') {
		throw new Error('Planner must return a header element first.');
	}
	console.log(`\nPlanner returned and processed ${elements.length} elements.`);

	// 6. Log a compact plan summary
	console.log('\n=== DASHBOARD PLAN ===');
	for (const element of elements) {
		console.log(`${element.type}: ${element.title}`);
	}

	// 7. Compose final dashboard body
	console.log('\nComposing dashboard...\n');

	// 8. Wrap, save, and open final HTML
	const finalHtml = await dashboardTemplate({
		elements: layoutElements(elements),
	});
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
