/**
 * RAG (RETRIEVAL-AUGMENTED GENERATION) PATTERN EXAMPLE
 *
 * Demonstrates building an intelligent knowledge retrieval system.
 *
 * HOW IT WORKS:
 * 1. Setup Phase: Downloads text, chunks it semantically, and indexes it using Vectra.
 * 2. Query Phase:
 *    - Retrieves broad candidates from Vector DB based on cosine similarity.
 *    - Agentic Filter: Uses LLM to verify relevance of every candidate in parallel.
 *    - Synthesizes final answer from verified chunks only.
 *
 * KEY CONCEPTS:
 * - "Parallel by Default, Sequential by Exception": Using `db!.insert` to handle file-system DB locks.
 * - Agentic RAG: A second-pass LLM filter ("Relevance Analyzer") reduces hallucinations by
 *   discarding vector matches that are semantically similar but factually irrelevant.
 * - Semantic Chunking: Using `semantic-chunker` to break text by meaning, not just lines.
 */

import { create } from 'casai';
import { basicModel, advancedModel, embeddingModel } from '../setup';
import { z } from 'zod';
import { embed } from 'ai';
import { LocalIndex } from 'vectra';
import semantic from 'semantic-chunker';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- Constants & Configuration ---

const SOTU_URL = 'https://raw.githubusercontent.com/langchain-ai/langchain/master/docs/docs/how_to/state_of_the_union.txt';
const INDEX_FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index');
const INPUT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'input.txt');

if (!existsSync(INDEX_FOLDER)) {
	mkdirSync(INDEX_FOLDER, { recursive: true });
}

// --- Type Definitions for Vectra ---

interface ChunkMetadata extends Record<string, string | number | boolean> {
	text: string;
}

// --- Helper Functions ---

const embeddingFunction = async (text: string) => {
	const { embedding } = await embed({
		model: embeddingModel,
		value: text,
	});
	return embedding;
};

// Initialize Vector Store
const index = new LocalIndex<ChunkMetadata>(INDEX_FOLDER, 'sotu_index');

// Download and Chunk text (Runs in standard JS before the agent script)
async function getRawChunks() {
	console.log('Downloading State of the Union...');
	const response = await fetch(SOTU_URL);
	const fullText = await response.text();

	console.log('Chunking text semantically...');
	const chunker = semantic({
		embed: embeddingFunction,
		zScoreThreshold: 2.0 // Adjust for chunk granularity
	});

	const chunks: { text: string, vector: number[] }[] = [];
	for await (const chunk of chunker(fullText)) {
		chunks.push({ text: chunk[0], vector: chunk[1] });
	}
	return chunks;
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
		isRelevant: z.boolean(),
		reasoning: z.string().describe('Short explanation of why this is or is not relevant')
	}),
	prompt: `We are answering the query: "{{ query }}"

Does the following text chunk contain specific information useful for answering this query?
Ignore chunks that only contain general pleasantries, applause, or unrelated topics.

CHUNK:
{{ chunkText }}`,
});

// 2. Synthesizer
// Generates the final answer using only the verified context.
const synthesizer = create.TextGenerator.withTemplate({
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

// --- Workflow 1: Indexing Agent (Cascada Script) ---

const indexingAgent = create.Script({
	inputSchema: z.object({
		rawChunks: z.array(z.object({
			text: z.string(),
			vector: z.array(z.number())
		}))
	}),
	context: {
		// Expose vector DB wrapper
		db: {
			// This method will be called sequentially via !
			insert: async (item: { vector: number[]; text: string }) => {
				await index.insertItem({
					vector: item.vector,
					metadata: { text: item.text }
				});
				process.stdout.write('.');
			}
		}
	},
	script: `:data
		// 'rawChunks' is passed in as an argument to the script
		for chunk in rawChunks
			// The '!' operator on 'db!' enforces strict sequential order for this specific path.
			// This prevents file-lock errors in Vectra (a file-based DB).
			db!.insert({
				vector: chunk.vector,
				text: chunk.text
			})
		endfor
	`
});

async function runIndexing() {
	if (await index.isIndexCreated()) {
		console.log('Vector index found. Skipping build.');
		return;
	}

	await index.createIndex();

	const chunks = await getRawChunks();
	console.log(`Indexing ${chunks.length} chunks...`);

	// Run the Cascada script
	await indexingAgent({ rawChunks: chunks });
	console.log('\nIndexing complete.');
}

// --- Workflow 2: Retrieval Agent (Cascada Script) ---

// JS Helper to interface with Vectra
async function queryVectorDb(query: string): Promise<string[]> {
	const queryVector = await embeddingFunction(query);
	// Retrieve top 20 items (Broad Search)
	const results = await index.queryItems(queryVector, query, 20);
	return results.map(r => r.item.metadata.text);
}

const ragAgent = create.Script({
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
		synthesizer,
		queryVectorDb,
		readQuery: async () => await fs.readFile(INPUT_FILE, 'utf-8'),
	},
	script: `:data
		var query = readQuery()

		// Step 1: Retrieve Candidates (JS Helper)
		var candidates = queryVectorDb(query)

		// Step 2: Agentic Filtering (Parallel Loop)
		// We verify every candidate in parallel. If the vector DB returned 20 items,
		// we run 20 LLM checks concurrently here.
		var verifiedChunks = capture :data
			@data = []
			for text in candidates
				var check = relevanceFilter({
					query: query,
					chunkText: text
				}).object

				if check.isRelevant
					@data.push(text)
				endif
			endfor
		endcapture

		// Step 3: Synthesize Answer
		var answer = synthesizer({
			query: query,
			chunks: verifiedChunks
		}).text

		// Output Result
		@data.query = query
		@data.stats = {
			found: candidates.length,
			verified: verifiedChunks.length
		}
		@data.answer = answer
	`
});

// --- Main Execution ---

console.log('--- Phase 1: Knowledge Base Setup ---');
await runIndexing();

console.log('\n--- Phase 2: RAG Agent Execution ---');
const result = await ragAgent();

console.log(`Q: ${result.query}`);
console.log(`Stats: Retrieved ${result.stats.found} candidates, Verified ${result.stats.verified} as relevant.`);
console.log(`\nAnswer:\n${result.answer}\n`);