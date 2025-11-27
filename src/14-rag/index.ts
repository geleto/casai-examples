/**
 * RAG (RETRIEVAL-AUGMENTED GENERATION) PATTERN EXAMPLE
 *
 * Demonstrates building an intelligent knowledge retrieval system.
 *
 * HOW IT WORKS:
 * 1. Setup Phase: Downloads text, chunks it semantically, and indexes it using Vectra.
 *    - Implemented in pure JS as requested to handle raw chunks directly.
 * 2. Query Phase:
 *    - Retrieves broad candidates from Vector DB based on cosine similarity.
 *    - Agentic Filter: Uses LLM to verify relevance of every candidate in parallel.
 *    - Synthesizes final answer from verified chunks only.
 *
 * KEY CONCEPTS:
 * - Agentic RAG: A second-pass LLM filter ("Relevance Analyzer") reduces hallucinations by
 *   discarding vector matches that are semantically similar but factually irrelevant.
 * - Semantic Chunking: Using `semantic-chunker` to break text by meaning, not just lines.
 */

import { create } from 'casai';
import { basicModel, advancedModel, embeddingModel } from '../setup';
import { z } from 'zod';
import { embed, embedMany } from 'ai';
import { LocalIndex } from 'vectra';
import { chunkText } from 'semachunk';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- Constants & Configuration ---

const SOTU_URL = 'https://huggingface.co/datasets/rewoo/sotu_qa_2023/resolve/main/state_of_the_union.txt';
const INDEX_FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vectra_index');
const INPUT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'input.txt');
const CONCURRENCY_LIMIT = 20;

if (!existsSync(INDEX_FOLDER)) {
	mkdirSync(INDEX_FOLDER, { recursive: true });
}

// --- Helper Functions ---

const batchEmbed = async (texts: string[]) => {
	const { embeddings } = await embedMany({
		model: embeddingModel,
		values: texts,
	});
	console.log(texts);
	return embeddings;
};

const singleEmbed = async (text: string) => {
	const { embedding } = await embed({
		model: embeddingModel,
		value: text,
	});
	console.log(text);
	return embedding;
};

// Initialize Vector Store
const index = new LocalIndex<{ text: string }>(INDEX_FOLDER, 'sotu_index');

// --- PHASE 1: Indexing (Standard JS) ---

async function runIndexing() {
	if (await index.isIndexCreated()) {
		console.log('Vector index found. Skipping build.');
		return;
	}

	console.log('Downloading State of the Union...');
	const response = await fetch(SOTU_URL);
	const fullText = await response.text();
	if (fullText.length < 1000) {
		throw new Error('Failed to download State of the Union text.');
	}

	await index.createIndex();

	console.log('Chunking text semantically...');

	const chunks = await chunkText(fullText, batchEmbed, {
		similarityThreshold: 0.6
	});

	console.log('Adding chunks to database...')
	let count = 0;
	for await (const chunk of chunks) {
		await index.insertItem({
			vector: chunk.embedding,
			metadata: { text: chunk.text }
		});
		process.stdout.write('.');
		count++;
	}
	console.log(`\nIndexed ${count} semantic chunks.`);
}

// --- Casai Components ---

// 1. Relevance Analyzer
// Acts as a "Gatekeeper". Vector search finds things that *look* similar,
// but this component reads the text to ensure it actually answers the question.
const relevanceFilter = create.ObjectGenerator.withTemplate({
	model: basicModel,
	inputSchema: z.object({
		query: z.string(),
		chunkText: z.string()
	}),
	schema: z.object({
		reasoning: z.string().describe('Short explanation of why this is or is not relevant'),
		isRelevant: z.boolean()
	}),
	prompt: `We are answering the query: "{{ query }}"

Does the following text chunk contain specific information useful for answering this query?
Ignore chunks that only contain general pleasantries, applause, or unrelated topics.

CHUNK:
{{ chunkText }}`,
});

// 2. synthesizeAnswer
// Generates the final answer using only the verified context.
const synthesizeAnswer = create.TextGenerator.withTemplate({
	model: advancedModel,
	inputSchema: z.object({
		query: z.string(),
		chunks: z.array(z.string())
	}),
	prompt: `Answer the question based ONLY on the provided context.
If the context is empty or insufficient, state that you don't have enough information.

QUESTION: {{ query }}

VERIFIED CONTEXT:
{% for text in chunks %}
---
{{ text }}
{% endfor %}

ANSWER:`,
});

// --- PHASE 2: Retrieval Agent (Cascada Script) ---

// JS Helper to interface with Vectra
async function queryVectorDb(query: string): Promise<string[]> {
	const queryVector = await singleEmbed(query);
	// Retrieve top 20 items (Broad Search)
	const results = await index.queryItems(queryVector, query, 20);
	return results.map(r => r.item.metadata.text);
}

const ragAgent = create.Script({
	inputSchema: z.object({
		query: z.string().optional() // Optional so we can run it without args to read from file
	}),
	schema: z.object({
		query: z.string(),
		stats: z.object({
			found: z.number(),
			verified: z.number()
		}),
		answer: z.string()
	}),
	context: {
		relevanceFilter,
		synthesizeAnswer,
		queryVectorDb,
		readQuery: async () => await fs.readFile(INPUT_FILE, 'utf-8'),
		CONCURRENCY_LIMIT
	},
	script: `:data
		@data = {}
		// Use provided query or read from file
		var queryText = query
		if not queryText
			queryText = readQuery()
		endif

		// Step 1: Retrieve Candidates (JS Helper)
		var candidates = queryVectorDb(queryText)

		// Step 2: Agentic Filtering (Parallel Loop)
		// Evaluate all candidates in parallel (up to CONCURRENCY_LIMIT).
		var verifiedChunks = capture :data
			@data = []
			for text in candidates of CONCURRENCY_LIMIT
				var check = relevanceFilter({
					query: queryText,
					chunkText: text
				}).object

				if check.isRelevant
					@data.push(text)
				endif
			endfor
		endcapture

		// Step 3: Synthesize Answer
		var answer = synthesizeAnswer({
			query: queryText,
			chunks: verifiedChunks
		}).text

		// Output Result
		@data.query = queryText
		@data.stats = {}
		@data.stats.found = candidates.length
		@data.stats.verified = verifiedChunks.length
		@data.answer = answer

	`
});

// --- Main Execution ---

console.log('--- Phase 1: Knowledge Base Setup ---');
await runIndexing();

console.log('\n--- Phase 2: RAG Agent Execution ---');
const result = await ragAgent({ query: '' });

console.log(`Q: ${result.query}`);
console.log(`Stats: Retrieved ${result.stats.found} candidates, Verified ${result.stats.verified} as relevant.`);
console.log(`\nAnswer:\n${result.answer}\n`);