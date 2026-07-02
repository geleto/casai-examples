/**
 * PLANNING PATTERN EXAMPLE: DASHBOARD GENERATOR
 *
 * Demonstrates an AI agent that creates a data dashboard by first planning
 * the layout and data requirements, then executing that plan.
 *
 * HOW IT WORKS:
 * 1. Generate a schema summary by inspecting the SQLite database
 * 2. Run three planner agents in parallel for metrics, visuals, and insights
 * 3. Each planned element is processed as soon as its planner section is ready
 * 4. For each data-backed element, generate and execute SQL to fetch the needed data
 * 5. Insight elements are converted into concise data-backed HTML
 * 6. Each element is rendered as an independent HTML/JS fragment
 * 7. A deterministic composer arranges the fragments and adds shared helpers/data
 *
 * KEY CONCEPTS:
 * - Planning Pattern: Break complex tasks into structured steps
 * - Structured Output: Use Zod schemas to enforce plan and render formats
 * - Tool Use: Dynamic SQL generation and database querying
 * - Concurrency: Element data fetching and rendering run in parallel
 * - Composition: Small generated fragments are assembled by simple TypeScript
 */

import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
import { basicModel, advancedModel, providerOptions } from '../setup';
import { create, FileSystemLoader } from 'casai';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import { Database } from './Database';
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
	if (element.type == 'header') return 'col-12';
	if (element.type != 'metric') {
		const isLastOddItem = contentIndex == contentCount - 1 && (contentCount - 1) % 2 == 1;
		return contentIndex == 0 || isLastOddItem ? 'col-12' : 'col-12 col-md-6';
	}
	if (metricCount == 2 || metricCount == 4 || (metricCount == 5 && metricIndex < 2)) {
		return 'col-12 col-md-6';
	}
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
// SQL generator - turns each natural-language data request into SQLite.
// ---------------------------------------------------------------------------
const sqlFromRequestGenerator = create.TextGenerator.loadsTemplate({
	model: advancedModel,
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
const dashboardProcessor = create.Script({
	context: {
		headerMetricPlanner,
		visualPlanner,
		insightTextPlanner,
		sqlFromRequestGenerator,
		sqlRepairGenerator,
		textInsightGenerator,
		elementRenderer,
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
	script: `
		function processElement(element)
			element.id = normalizeElementId(element.type, element.id)
			var rows = []
			if element.usesData and element.dataRequest
				var sql = sqlFromRequestGenerator({
					datasetDescription: datasetDescription,
					schemaSummary: schemaSummary,
					elementType: element.type,
					dataRequest: element.dataRequest
				}).text
				var queryResult = database.tryExecuteSql(sql)
				var repairAttempts = 0
				while repairAttempts < 2 and (queryResult.ok == false or queryResult.rows.length == 0)
					repairAttempts = repairAttempts + 1
					sql = sqlRepairGenerator({
						datasetDescription: datasetDescription,
						schemaSummary: schemaSummary,
						elementType: element.type,
						dataRequest: element.dataRequest,
						previousSql: sql,
						failureReason: queryResult.error if queryResult.ok == false else "The query returned zero rows.",
						repairAttempt: repairAttempts
					}).text
					queryResult = database.tryExecuteSql(sql)
				endwhile
				rows = queryResult.rows
				element.previewJson = generatePreviewJson(rows)
				if queryResult.ok == false or (element.type == "chart" and rows.length == 0)
					element.queryError = queryResult.error if queryResult.ok == false else "The query returned zero rows."
					return element
				endif
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
			var renderedElement = elementRenderer({
				elementJson: toJson(element)
			}).object
			// Build dashboard fields after rendering so the renderer prompt is not filled with complete data.
			element.html = renderedElement.html
			element.script = renderedElement.script.trim()
			if element.usesData
				element.dataJson = toJson(element.id) ~ ": " ~ toJson(rows)
			endif
			return element
		endfunction

		var plannerInput = {
			datasetName: datasetName,
			datasetDescription: datasetDescription,
			userRequest: userRequest,
			schemaSummary: schemaSummary
		}

		var headerMetrics = headerMetricPlanner(plannerInput).elementStream
		var chartsTables = visualPlanner(plannerInput).elementStream
		var insightsText = insightTextPlanner(plannerInput).elementStream

		data processedElements = []
		for section in [headerMetrics, chartsTables, insightsText]
			for element in section
				processedElements.push(processElement(element))
			endfor
		endfor
		return processedElements.snapshot()`
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
	console.log(`\n=== Schema Summary ===\n${schemaSummary}`);

	// 4. Plan sections, fetch data, generate insights, and render each card
	console.log('\nRunning planner sections and processing elements...\n');
	const elements = await dashboardProcessor({ database, schemaSummary });
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
