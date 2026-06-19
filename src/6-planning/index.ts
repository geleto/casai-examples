/**
 * PLANNING PATTERN EXAMPLE: DASHBOARD GENERATOR
 *
 * Demonstrates an AI agent that creates a data dashboard by first planning
 * the layout and data requirements, then executing that plan.
 *
 * HOW IT WORKS:
 * 1. Generate a schema summary by inspecting the SQLite database
 * 2. Run three planner agents in parallel for KPIs, visuals, and insights
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

const dashboardElementSchema = z.object({
	id: z.string().describe('Unique identifier for the element'),
	type: z.enum(['header', 'chart', 'table', 'text', 'insight', 'kpi', 'other']).describe('Type of dashboard element'),
	title: z.string().describe('Display title for the element'),
	description: z.string().describe('Brief description of what this element shows'),
	usesData: z.boolean().describe('Whether this element requires data fetching'),
	dataRequest: z.string().optional().describe('Natural language description of needed data (if usesData is true)'),
});

const headerKpiElementSchema = dashboardElementSchema.extend({
	type: z.enum(['header', 'kpi']),
});
const visualElementSchema = dashboardElementSchema.extend({
	type: z.enum(['chart', 'table']),
});
const insightTextElementSchema = dashboardElementSchema.extend({
	type: z.enum(['insight', 'text']),
});

const renderedElementSchema = z.object({
	id: z.string(),
	type: z.enum(['header', 'chart', 'table', 'text', 'insight', 'kpi', 'other']),
	html: z.string().describe('HTML fragment with no row/column wrapper'),
	script: z.string().describe('Raw JavaScript statements to run inside an existing DOMContentLoaded listener. Use an empty string if none.'),
});

const processedElementSchema = dashboardElementSchema.extend({
	previewJson: z.string().optional(),
	contentHtml: z.string().optional(),
	html: z.string(),
	script: z.string(),
	dataJson: z.string().optional(),
});

const processedDashboardSchema = z.array(processedElementSchema);

type ProcessedElement = z.infer<typeof processedElementSchema>;
interface LayoutElement extends ProcessedElement {
	columnClass: string;
}

function columnClass(element: ProcessedElement, kpiIndex: number, kpiCount: number, contentIndex: number, contentCount: number): string {
	if (element.type == 'header') return 'col-12';
	if (element.type != 'kpi') {
		const isLastOddItem = contentIndex == contentCount - 1 && (contentCount - 1) % 2 == 1;
		return contentIndex == 0 || isLastOddItem ? 'col-12' : 'col-12 col-md-6';
	}
	if (kpiCount == 2 || kpiCount == 4 || (kpiCount == 5 && kpiIndex < 2)) {
		return 'col-12 col-md-6';
	}
	return kpiCount > 5 ? 'col-12 col-md-6 col-xl-4' : 'col-12 col-md-4';
}

function layoutElements(elements: ProcessedElement[]): LayoutElement[] {
	const kpiCount = elements.filter(element => element.type == 'kpi').length;
	const contentCount = elements.filter(element => element.type != 'header' && element.type != 'kpi').length;
	let kpiIndex = 0, contentIndex = 0;
	return [...elements]
		.sort((a, b) => layoutPriority(a) - layoutPriority(b))
		.map(element => {
			const column = columnClass(element, kpiIndex, kpiCount, contentIndex, contentCount);
			if (element.type == 'kpi') kpiIndex++;
			else if (element.type != 'header') contentIndex++;
			return {
				...element,
				columnClass: column,
			};
		});
}

function layoutPriority(element: { type: ProcessedElement['type'] }): number {
	return {
		header: 0, kpi: 1, chart: 2, table: 3, insight: 4, text: 5, other: 6,
	}[element.type];
}

function safeScriptText(value: string): string {
	return value.replace(/<\/script/gi, '<\\/script');
}

// ---------------------------------------------------------------------------
// Planner LLMs - create independent sections of the dashboard plan.
// ---------------------------------------------------------------------------
const plannerConfig = create.Config({
	model: advancedModel,
	providerOptions,
	loader: templateLoader,
	output: 'array',
});

const headerKpiPlanner = create.ObjectGenerator.loadsTemplate({
	prompt: 'header-kpi-planner.md',
	schema: headerKpiElementSchema,
}, plannerConfig);

const visualPlanner = create.ObjectGenerator.loadsTemplate({
	prompt: 'visual-planner.md',
	schema: visualElementSchema,
}, plannerConfig);

const insightTextPlanner = create.ObjectGenerator.loadsTemplate({
	prompt: 'insight-text-planner.md',
	schema: insightTextElementSchema,
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
	schema: renderedElementSchema,
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
		headerKpiPlanner,
		visualPlanner,
		insightTextPlanner,
		sqlFromRequestGenerator,
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
		safeScriptText,
		datasetDescription: input.datasetDescription,
		datasetName: input.datasetName,
		userRequest: input.userRequest,
	},
	schema: processedDashboardSchema,
	script: `
		function processElement(element)
			var rows = []
			if element.usesData and element.dataRequest
				var sql = sqlFromRequestGenerator({
					datasetDescription: datasetDescription,
					schemaSummary: schemaSummary,
					elementType: element.type,
					dataRequest: element.dataRequest
				}).text
				rows = database.executeSql(sql)
				element.previewJson = generatePreviewJson(rows)
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
			element.script = safeScriptText(renderedElement.script.trim())
			if element.usesData
				element.dataJson = safeScriptText(toJson(element.id) ~ ": " ~ toJson(rows))
			endif
			return element
		endfunction

		var plannerInput = {
			datasetName: datasetName,
			datasetDescription: datasetDescription,
			userRequest: userRequest,
			schemaSummary: schemaSummary
		}

		//TODO: use array streans when implemented
		var headerKpis = headerKpiPlanner(plannerInput).object
		var chartsTables = visualPlanner(plannerInput).object
		var insightsText = insightTextPlanner(plannerInput).object

		data processedElements = []
		for section in [headerKpis, chartsTables, insightsText]
			for element in section
				processedElements.push(processElement(element))
			endfor
		endfor
		return processedElements.snapshot()`
});

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
