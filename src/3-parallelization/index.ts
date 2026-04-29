/**
 * PARALLELIZATION PATTERN EXAMPLE
 *
 * Demonstrates automatic parallel execution through simple for loops.
 *
 * HOW IT WORKS:
 * 1. Identify markets
 * 2. Find stocks (for loop - Cascada parallelizes)
 * 3. Analyze stocks (for loop - Cascada parallelizes)
 * 4. Rank in JS
 *
 * KEY CONCEPTS:
 * - Write simple for loops - Cascada parallelizes automatically
 * - Use data channels with snapshot() to collect ordered parallel results
 * - TextGenerator for prose, ObjectGenerator for structured data
 * - Use output: 'array' for simple array outputs
 * - Do math and sorting in JS, not in LLM
 * - Templates for all text formatting (prompts and output)
 *
 * TODO: Skip when there are duplicates between categories
 */

import { basicModel, advancedModel } from '../setup';
import { create, FileSystemLoader, z } from 'casai';
import { fileURLToPath } from 'url';
import inputData from './input.json';
import * as types from './types';

// Define model configurations
const quickConfig = create.Config({
	model: basicModel
});

const analyticalConfig = create.Config({
	model: advancedModel
});

// Shared loader for all templates (instead of path)
const templatesDir = fileURLToPath(new URL('./templates', import.meta.url));
const templateLoader = new FileSystemLoader(templatesDir);

// Define generators - all loading from templates folder

const marketIdentifier = create.ObjectGenerator.loadsTemplate({
	loader: templateLoader,
	output: 'array',
	// Cascada wants schema even for string array outputs
	schema: z.string(),
	prompt: 'identify-markets.md',
}, analyticalConfig);

const stockFinder = create.ObjectGenerator.loadsTemplate({
	loader: templateLoader,
	output: 'object',
	schema: types.StockListSchema,
	prompt: 'find-stocks.md',
}, analyticalConfig);

const companyInfoExtractor = create.TextGenerator.loadsTemplate({
	loader: templateLoader,
	prompt: 'extract-info.md',
}, quickConfig);

const analysisWriter = create.TextGenerator.loadsTemplate({
	loader: templateLoader,
	prompt: 'analyze.md',
}, analyticalConfig);

const componentScorer = create.ObjectGenerator.loadsTemplate({
	loader: templateLoader,
	output: 'object',
	schema: types.ComponentScoresSchema,
	prompt: 'score-components.md',
}, analyticalConfig);

// Load text templates

const investmentContextTemplate = create.Template.loadsTemplate({
	loader: templateLoader,
	template: 'investment-context.txt',
});

const outputTemplate = create.Template.loadsTemplate({
	loader: templateLoader,
	template: 'output.txt',
});

// JS helper functions (with proper types)
// Now it THROWS so Cascada can detect with `is error` in the script
async function fetchYahooFinance(ticker: string): Promise<string> {
	const response = await fetch(`https://finance.yahoo.com/quote/${ticker}/`);
	if (!response.ok) {
		throw new Error(`Failed to fetch Yahoo Finance data for ${ticker}`);
	}
	const html = await response.text();
	return html.substring(0, 50000);
}

function calculateFinalScore(scores: types.ComponentScores): number {
	return (
		scores.criteriaAlignment * 0.3 +
		scores.financialStrength * 0.2 +
		scores.growthPotential * 0.25 +
		scores.marketPosition * 0.15 +
		scores.contrarianScore * 0.1 -
		scores.riskLevel * 0.25
	);
}

// fixed version (no TS typos)
function rankAndFilter(analyses: types.StockAnalysis[], config: types.Config): types.RankedStockAnalysis[] {
	const sorted = [...analyses].sort((a, b) => b.finalScore - a.finalScore);
	const result: types.RankedStockAnalysis[] = [];
	const marketCounts: Record<string, number> = {};

	for (const stock of sorted) {
		const count = marketCounts[stock.market] || 0;
		if (count < config.numMaxStocksPerMarket && result.length < config.numTopStocks) {
			result.push({
				rank: result.length + 1,
				...stock,
			});
			marketCounts[stock.market] = count + 1;
		}
	}
	return result;
}

// 6. Create the orchestrator script
const stockAnalysisAgent = create.Script({
	schema: types.StockAnalysisResultSchema,
	context: {
		config: inputData,
		marketIdentifier,
		stockFinder,
		companyInfoExtractor,
		analysisWriter,
		componentScorer,
		investmentContextTemplate,
		fetchYahooFinance,
		calculateFinalScore,
		rankAndFilter
	},
	script: `
		// Create reusable investment context string
		var investmentContext = investmentContextTemplate(config)

		// STEP 1: Identify markets (returns string array directly)
		var markets = marketIdentifier(config).object

		// STEP 2: Find stocks (parallel per market via for loop)
		data foundStocks
		foundStocks = []
		for market in markets
			var result = stockFinder({
				marketName: market,
				investmentContext: investmentContext,
				numStocksPerMarket: config.numStocksPerMarket
			}).object.stocks

			if result is not error
				for stock in result
					if stock is not error
						foundStocks.push({
							companyName: stock.companyName,
							ticker: stock.ticker,
							market: market
						})
					endif
				endfor
			endif
		endfor
		var allStocks = foundStocks.snapshot()

		// STEP 3: Analyze stocks (parallel via for loop)
		data stockAnalyses
		stockAnalyses = []
		for stock in allStocks
			// this will be 'error' if fetchYahooFinance threw in JS
			var yahooData = fetchYahooFinance(stock.ticker)

			if yahooData is not error
				var companyInfo = companyInfoExtractor({
					ticker: stock.ticker,
					yahooData: yahooData
				}).text

				if companyInfo is not error
					var analysis = analysisWriter({
						ticker: stock.ticker,
						companyName: stock.companyName,
						market: stock.market,
						companyInfo: companyInfo,
						investmentContext: investmentContext
					}).text

					var scores = componentScorer({
						ticker: stock.ticker,
						companyName: stock.companyName,
						analysis: analysis,
						investmentContext: investmentContext
					}).object

					var finalScore = calculateFinalScore(scores)

					stockAnalyses.push({
						ticker: stock.ticker,
						companyName: stock.companyName,
						market: stock.market,
						analysis: analysis,
						criteriaAlignment: scores.criteriaAlignment,
						financialStrength: scores.financialStrength,
						growthPotential: scores.growthPotential,
						marketPosition: scores.marketPosition,
						contrarianScore: scores.contrarianScore,
						riskLevel: scores.riskLevel,
						finalScore: finalScore
					})
				endif
			endif
		endfor
		var analyses = stockAnalyses.snapshot()

		// STEP 4: Rank and filter in JS
		var topStocks = rankAndFilter(analyses, config)

		// OUTPUT
		return {
			markets: markets,
			total: allStocks.length,
			analyzed: analyses.length,
			skipped: allStocks.length - analyses.length,
			topStocks: topStocks
		}
	`
});

// Run the agent
console.log('PARALLELIZATION PATTERN EXAMPLE\nDemonstrates automatic parallel execution through simple for loops.\n');
console.log('Disclaimer: This analysis is for educational purposes only and does not constitute financial advice.\n');

const result = await stockAnalysisAgent() as types.StockAnalysisResult;

// Format and print output using template
const output = await outputTemplate(result);
console.log(output);
