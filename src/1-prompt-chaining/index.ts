/**
 * PROMPT CHAINING EXAMPLE
 *
 * Demonstrates breaking down a complex task into a sequence of simpler steps.
 *
 * HOW IT WORKS:
 * 1. Research: Gather key facts about the topic
 * 2. Outline: Structure the information
 * 3. Write: Create full article from the outline
 * 4. Title: Generate a catchy headline
 *
 * KEY CONCEPTS:
 * - Each step outputs feed into the next step's inputs
 * - Linear workflow (no loops or conditionals)
 * - Break complex tasks into manageable pieces
 * - Clear separation of concerns
 */

import fs from 'fs/promises';
import { basicModel, providerOptions } from '../setup';
import { create, FileSystemLoader, z } from 'casai';
import { fileURLToPath } from 'url';

console.log('PROMPT CHAINING EXAMPLE\nDemonstrates breaking down a complex task into a sequence of simpler steps.\n');

const inputFile = new URL('./input.txt', import.meta.url);
const templateLoader = new FileSystemLoader(fileURLToPath(new URL('./templates', import.meta.url)));

// 1. Define base configuration
const baseLLMConfig = create.Config({
	model: basicModel,
	providerOptions,
});

// 2. Define each step in the chain

// Step 1: Research phase - gather key information
const researcher = create.TextGenerator.withTemplate({
	prompt: 'List 5-7 key facts or insights about {{ topic }}. Be specific and informative.',
}, baseLLMConfig);

// Step 2: Outline phase - structure the information
const outliner = create.TextGenerator.withTemplate({
	prompt: 'Create a clear outline for an article based on these facts:\n\n{{ facts }}\n\nProvide 3-4 main sections with brief descriptions.',
}, baseLLMConfig);

// Step 3: Writing phase - create full content
const writer = create.TextGenerator.withTemplate({
	prompt: 'Write a complete, engaging article following this outline:\n\n{{ outline }}\n\nMake it informative and easy to read.',
}, baseLLMConfig);

// Step 4: Title generation - create compelling headline
const titleGenerator = create.TextGenerator.withTemplate({
	prompt: 'Create a catchy, engaging title for this article:\n\n{{ article }}\n\nTitle:',
}, baseLLMConfig);

const outputTemplate = create.Template.loadsTemplate({
	loader: templateLoader,
	template: 'output.txt',
});

const ArticleResultSchema = z.object({
	title: z.string(),
	article: z.string(),
	outline: z.string(),
	facts: z.string(),
});

// 3. Chain the steps together in a script
const articleAgent = create.Script({
	schema: ArticleResultSchema,
	context: {
		researcher,
		outliner,
		writer,
		titleGenerator,
		readTopic: async () => (await fs.readFile(inputFile, 'utf-8')).trim(),
	},
	script: `
		// Step 1: Research the topic
		var topic = readTopic()
		var facts = researcher({ topic: topic }).text

		// Step 2: Create an outline from the facts
		var outline = outliner({ facts: facts }).text

		// Step 3: Write the full article from the outline
		var article = writer({ outline: outline }).text

		// Step 4: Generate a title for the article
		var title = titleGenerator({ article: article }).text

		// Output the final result
		return {
			title: title,
			article: article,
			outline: outline,
			facts: facts
		}
	`
});

// 4. Run the chain
const result = ArticleResultSchema.parse(await articleAgent());
const output = await outputTemplate(result);
console.log(output);
