import { z } from 'casai';

const dashboardElementSchema = z.object({
	id: z.string().describe('Unique identifier for the element'),
	type: z.enum(['header', 'metric', 'chart', 'table', 'text', 'insight', 'other']).describe('Type of dashboard element'),
	title: z.string().describe('Display title for the element'),
	description: z.string().describe('Brief description of what this element shows'),
	usesData: z.boolean().describe('Whether this element requires data fetching'),
	dataRequest: z.string().describe('Natural language description of needed data, or an empty string if usesData is false'),
	requiredTables: z.array(z.string()).describe('Exact SQLite table names needed for the data request, or [] if usesData is false'),
});

const processedElementSchema = dashboardElementSchema.extend({
	previewJson: z.string().optional(),
	contentHtml: z.string().optional(),
	queryError: z.string().optional(),
	html: z.string().optional(),
	script: z.string().optional(),
	dataJson: z.string().optional(),
});

export const schemas = {
	dashboardElement: dashboardElementSchema,
	headerMetricElement: dashboardElementSchema.extend({
		type: z.enum(['header', 'metric']),
	}),
	visualElement: dashboardElementSchema.extend({
		type: z.enum(['chart', 'table']),
	}),
	insightTextElement: dashboardElementSchema.extend({
		type: z.enum(['insight', 'text']),
	}),
	renderedElement: z.object({
		id: z.string(),
		type: z.enum(['header', 'metric', 'chart', 'table', 'text', 'insight', 'other']),
		html: z.string().describe('HTML fragment with no row/column wrapper'),
		script: z.string().describe('Raw JavaScript statements to run inside an existing DOMContentLoaded listener. Use an empty string if none.'),
	}),
	processedElement: processedElementSchema,
	processedDashboard: z.array(processedElementSchema),
};

export namespace types {
	export interface PlanningScenario {
		name: string;
		userRequest: string;
		datasetName: string;
		datasetDescription: string;
		databaseUrl: string;
		port: number;
	}

	export interface PlanningInputFile {
		activeScenario: string;
		scenarios: Record<string, PlanningScenario>;
	}

	export type ProcessedElement = z.infer<typeof schemas.processedElement>;

	export interface LayoutElement extends ProcessedElement {
		columnClass: string;
	}
}
