# Casai Examples

A collection of practical examples demonstrating AI agent patterns using [Casai](https://github.com/cascada-ai/casai) - a framework for building structured AI workflows with the Vercel AI SDK.

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Running Examples](#running-examples)
- [Customizing Examples](#customizing-examples)
- [Examples Overview](#examples-overview)

## Installation

### Prerequisites

- Node.js (v18 or higher recommended)
- npm or pnpm
- API keys for any model provider supported by [Vercel AI SDK](https://sdk.vercel.ai/providers/ai-sdk-providers)

### Setup Steps

1. **Clone or download this repository**

```bash
git clone <repository-url>
cd casai-examples
```

2. **Install dependencies**

```bash
npm install
```

3. **Configure API keys**

Create a `.env` file in the project root with your API keys:

```bash
# Add keys for the providers you want to use
OPENAI_API_KEY=your_openai_api_key_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here
GOOGLE_GENERATIVE_AI_API_KEY=your_google_api_key_here
# ... any other Vercel AI SDK supported provider
```

Common providers:
- OpenAI: https://platform.openai.com/api-keys
- Anthropic: https://console.anthropic.com/settings/keys
- Google AI: https://aistudio.google.com/app/apikey
- See full list: https://sdk.vercel.ai/providers/ai-sdk-providers

## Configuration

### Global Configuration (`src/setup.ts`)

The `setup.ts` file exports two pre-configured models used across examples:

```typescript
// Basic model for simple tasks (faster, cheaper)
export const basicModel = withProgressIndicator(
  openai('gpt-4.1-nano'),
  'GPT-4o-nano',
  showProgressIndicators
);

// Advanced model for complex tasks (more capable)
export const advancedModel = withProgressIndicator(
  anthropic('claude-3-7-sonnet-latest'),
  'Claude-3.7-Sonnet',
  showProgressIndicators
);
```

**Configuration options:**

- **Model Selection**: Change the model provider/version in the first parameter
  - OpenAI: `openai('gpt-4.1-nano')`, `openai('gpt-4o')`, etc.
  - Anthropic: `anthropic('claude-3-7-sonnet-latest')`, `anthropic('claude-3-5-sonnet-20241022')`, etc.

- **Progress Indicators**: Set `showProgressIndicators` to `true` or `false`
  - `true`: Shows detailed logging of LLM calls with token counts and timing
  - `false`: Silent mode (no progress output)

**Example progress output:**
```
[GPT-4o-nano #1] 🚩 Start generating | prompt: "Write a short, engaging..." | active: 1
[GPT-4o-nano #1] ✅ Complete generating: 239 tokens in 3.62s | active: 0
```

## Running Examples

Use the `npm run example` command followed by the example number:

```bash
# Run example 1 (Prompt Chaining)
npm run example 1

# Run example 2 (Routing)
npm run example 2

# Run example 3 (Parallelization)
npm run example 3

# Run example 4 (Reflection)
npm run example 4
```

The script automatically finds and executes the matching example directory (e.g., `1-prompt-chaining`, `2-routing`, `3-parallelization`, `4-reflection`).

## Cleaning Data

Some examples may generate local data (e.g., vector indices, downloaded files). To clean up this generated data:

```bash
npm run clean
```

This will remove generated artifacts like the `vectra_index` directory.

## Customizing Examples

### Modifying Input Data

Each example reads from its own `input.txt` file. To test with different inputs:

1. Navigate to the example directory (e.g., `src/1-prompt-chaining/`)
2. Edit the `input.txt` file with your desired input
3. Run the example: `npm run example 1`

### Example-Specific Configuration

Each example's `index.ts` can be modified to adjust behavior:

**Temperature settings:**
```typescript
const baseLLMConfig = create.Config({
  model: basicModel,
  temperature: 0.7,  // 0.0 = deterministic, 1.0 = creative
});
```

**Model selection per task:**
```typescript
// Use basic model for simple tasks
const researcher = create.TextGenerator.withTemplate({
  prompt: 'List 5-7 key facts...',
}, baseLLMConfig);

// Override with advanced model for complex tasks
const critiqueGenerator = create.ObjectGenerator.withTemplate({
  model: advancedModel,  // Override the base config
  output: 'object',
  schema: z.object({...}),
  prompt: 'Critique this...',
}, baseLLMConfig);
```

**Workflow parameters:**
```typescript
// In Example 4 (Reflection)
context: {
  qualityThreshold: 8,     // Minimum acceptable score (1-10)
  maxRevisions: 3,         // Maximum revision attempts
}
```

### Debug Mode

Enable detailed logging for any component:

```typescript
const component = create.TextGenerator.withTemplate({
  debug: true,  // Enable debug output
  prompt: '...',
}, config);
```

Or for the entire script:

```typescript
const agent = create.Script({
  debug: true,  // Enable script-level debugging
  context: {...},
  script: `...`
});
```

## Examples Overview

### Example 1: Prompt Chaining (`src/1-prompt-chaining/`)

Demonstrates breaking down a complex task into a sequence of simpler steps.
- **Linear Workflow**: Executes steps in order: Research → Outline → Write → Title.
- **State Management**: Passes outputs from one step as inputs to the next.
- **Separation of Concerns**: Each step focuses on a specific sub-task for better quality.

### Example 2: Routing (`src/2-routing/`)

Demonstrates routing different types of inputs to specialized handlers.
- **Classification**: Uses an LLM to categorize inquiries (Technical, Billing, General, Urgent).
- **Specialized Handlers**: Routes to specific prompts/configs optimized for each category.
- **Conditional Logic**: Uses `switch` or `if/else` logic to direct control flow.

### Example 3: Parallelization (`src/3-parallelization/`)

Demonstrates automatic parallel execution through simple for loops.
- **Automatic Concurrency**: Cascada automatically parallelizes independent iterations in `for` loops.
- **Hybrid Logic**: Combines LLM generation (finding/analyzing stocks) with JS logic (ranking/filtering).
- **Structured Data**: Collects and processes structured data from multiple parallel streams.

### Example 4: Reflection (`src/4-reflection/`)

Demonstrates an AI agent that improves its own output through self-critique.
- **Self-Correction Loop**: Generates a draft, critiques it, and revises based on feedback.
- **Quality Control**: Continues revising until a quality threshold is met or max revisions reached.
- **Structured Feedback**: Uses specific scoring and suggestions to guide improvements.

### Example 5: Tool Use (`src/5-tool/`)

Demonstrates how to create custom tools that LLMs can use to solve problems.
- **LLM-Powered Tools**: Creates a tool that uses an LLM to interpret natural language (time references).
- **API Integration**: Connects to external weather and geocoding APIs.
- **Tool Composition**: Shows an agent combining multiple tools to answer complex queries.

### Example 14: RAG (`src/14-rag/`)

Demonstrates a Retrieval-Augmented Generation system with agentic filtering.
- **Semantic Chunking**: Splits text by meaning rather than fixed size.
- **Vector Search**: Retrieves broad candidates using cosine similarity.
- **Agentic Filtering**: A second-pass LLM verifies relevance of each chunk to improve the context for the final answer.

## Troubleshooting

**Issue: "No API key found"**
- Ensure `.env` file exists in the project root
- Verify API keys are correctly set
- Restart your terminal/IDE after creating `.env`

**Issue: "Example not found"**
- Check that you're using the correct number prefix
- List available examples: `ls src/` or check the `src/` directory

**Issue: Rate limiting or API errors**
- Check your API key has sufficient credits
- Reduce `temperature` or use smaller models
- Add delays between calls if hitting rate limits

## Learn More

- [Casai Documentation](https://github.com/geleto/casai)
- [Vercel AI SDK](https://sdk.vercel.ai/)
- [Cascada Engine](https://github.com/geleto/cascada)
- [Cascada Script Language](https://github.com/geleto/cascada/blob/master/docs/cascada/script.mde)

## License

Apache-2.0
