/**
 * PLANNING PATTERN EXAMPLE: DASHBOARD GENERATOR
 *
 * Demonstrates an AI agent that creates a data dashboard by first planning
 * the layout and data requirements, then executing that plan.
 *
 * HOW IT WORKS:
 * 1. Generate a schema summary by inspecting the SQLite database
 * 2. Analyze the user request and schema to plan dashboard elements
 * 3. Planner Agent returns structured dashboard elements, with a header first
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

const collectedData: Record<string, unknown> = {};
let dataPointCounter = 1;

const dashboardElementSchema = z.object({
	id: z.string().describe('Unique identifier for the element'),
	type: z.enum(['header', 'chart', 'table', 'text', 'insight', 'kpi', 'other']).describe('Type of dashboard element'),
	layoutHint: z.enum(['full-width', 'half-width', 'third-width', 'auto']).describe('Suggested layout width'),
	title: z.string().describe('Display title for the element'),
	description: z.string().describe('Brief description of what this element shows'),
	usesData: z.boolean().describe('Whether this element requires data fetching'),
	dataRequest: z.string().optional().describe('Natural language description of needed data (if usesData is true)'),
});

const renderedElementSchema = z.object({
	id: z.string(),
	type: z.enum(['header', 'chart', 'table', 'text', 'insight', 'kpi', 'other']),
	layoutHint: z.enum(['full-width', 'half-width', 'third-width', 'auto']),
	html: z.string().describe('HTML fragment with no row/column wrapper'),
	script: z.string().describe('Raw JavaScript statements to run inside an existing DOMContentLoaded listener. Use an empty string if none.'),
});

const processedElementSchema = dashboardElementSchema.extend({
	dataKey: z.string().optional(),
	previewJson: z.string().optional(),
	contentHtml: z.string().optional(),
});

const processedDashboardSchema = z.object({
	elements: z.array(processedElementSchema),
	renderedElements: z.array(renderedElementSchema),
});

type RenderedElement = z.infer<typeof renderedElementSchema>;
interface LayoutElement {
	id: string;
	type: RenderedElement['type'];
	columnClass: string;
	html: string;
	script: string;
	idJson: string;
}

function columnClass(element: RenderedElement, kpiIndex: number, kpiCount: number, contentIndex: number, contentCount: number): string {
	if (element.type == 'header') return 'col-12';
	if (element.type != 'kpi') {
		const isLastOddItem = contentIndex == contentCount - 1 && (contentCount - 1) % 2 == 1;
		return contentIndex == 0 || isLastOddItem ? 'col-12' : 'col-12 col-lg-6';
	}
	if (kpiCount == 2 || kpiCount == 4 || (kpiCount == 5 && kpiIndex < 2)) {
		return 'col-12 col-md-6';
	}
	return kpiCount > 5 ? 'col-12 col-md-6 col-xl-4' : 'col-12 col-md-4';
}

function layoutElements(elements: RenderedElement[]): LayoutElement[] {
	const kpiCount = elements.filter(element => element.type == 'kpi').length;
	const contentCount = elements.filter(element => element.type != 'header' && element.type != 'kpi').length;
	let kpiIndex = 0, contentIndex = 0;
	return elements.map(element => {
		const column = columnClass(element, kpiIndex, kpiCount, contentIndex, contentCount);
		if (element.type == 'kpi') kpiIndex++;
		else if (element.type != 'header') contentIndex++;
		return {
			id: element.id,
			type: element.type,
			columnClass: column,
			html: element.html,
			script: element.script.trim().replace(/<\/script/gi, '<\\/script'),
			idJson: JSON.stringify(element.id),
		};
	}).sort((a, b) => layoutPriority(a) - layoutPriority(b));
}

function layoutPriority(element: LayoutElement): number {
	if (element.type == 'header') return 0;
	if (element.type == 'kpi') return 1;
	return 2;
}

// ---------------------------------------------------------------------------
// Planner LLM - creates the structured dashboard element plan.
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
// Element processor - fetches data, creates insights, and renders cards.
// ---------------------------------------------------------------------------
const elementProcessor = create.Script({
	context: {
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
		saveData: (rows: any[], database: Database) => {
			const dataKey = `${database.datasetName}_${dataPointCounter++}`;
			collectedData[dataKey] = rows;
			return dataKey;
		},
		toJson: (value: unknown) => JSON.stringify(value, null, 2),
		datasetDescription: input.datasetDescription,
		datasetName: input.datasetName,
		userRequest: input.userRequest,
	},
	schema: processedDashboardSchema,
	script: `
		data processedElements = []
		data renderedElements = []
		for element in elements
			if element.usesData and element.dataRequest
				var sqlResult = sqlFromRequestGenerator({
					datasetDescription: datasetDescription,
					schemaSummary: schemaSummary,
					elementType: element.type,
					dataRequest: element.dataRequest
				}).text
				var rows = database.executeSql(sqlResult)
				element.previewJson = generatePreviewJson(rows)
				element.dataKey = saveData(rows, database)
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
			var renderedElement = elementRenderer({
				elementJson: toJson(element)
			}).object
			renderedElements.push(renderedElement)
		endfor
		return {
			elements: processedElements.snapshot(),
			renderedElements: renderedElements.snapshot()
		}`
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

	// 4. Run planner with structured output
	console.log('\nRunning planner agent (Structured Output)...\n');
	const elements = (await plannerAgent({
		datasetName: input.datasetName,
		datasetDescription: input.datasetDescription,
		userRequest: input.userRequest,
		schemaSummary,
	})).object;
	if (elements[0]?.type != 'header') {
		throw new Error('Planner must return a header element first.');
	}
	console.log(`\nPlanner returned ${elements.length} elements. Processing data requests...`);

	// 5. Process elements: fetch data, generate insights, and render each card
	const processedDashboard = await elementProcessor({ elements, database, schemaSummary }) as z.infer<typeof processedDashboardSchema>;

	// 6. Log a compact plan summary
	console.log('\n=== DASHBOARD PLAN ===');
	for (const element of processedDashboard.elements) {
		console.log(`${element.type}: ${element.title}`);
	}

	// 7. Compose final dashboard body
	console.log('\nComposing dashboard...\n');

	// 8. Wrap, save, and open final HTML
	const finalHtml = await dashboardTemplate({
		title: elements[0].title,
		elements: layoutElements(processedDashboard.renderedElements),
		dataJson: JSON.stringify(collectedData),
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
