import { z } from 'casai';

// Schemas - only where structure needed

export const StockListSchema = z.object({
	stocks: z.array(z.object({
		companyName: z.string(),
		ticker: z.string(),
	})),
});

export const ComponentScoresSchema = z.object({
	criteriaAlignment: z.number().min(0).max(10),
	financialStrength: z.number().min(0).max(10),
	growthPotential: z.number().min(0).max(10),
	marketPosition: z.number().min(0).max(10),
	contrarianScore: z.number().min(0).max(10),
	riskLevel: z.number().min(0).max(10),
});

// Derive type from schema
export type ComponentScores = z.infer<typeof ComponentScoresSchema>;

// Reuse scores inside stock analysis (rank is kept out initially)
export const StockAnalysisSchema = ComponentScoresSchema.extend({
	ticker: z.string(),
	companyName: z.string(),
	market: z.string(),
	analysis: z.string(),
	finalScore: z.number(),
});

// This is what we finally return from JS after ranking
export const RankedStockAnalysisSchema = StockAnalysisSchema.extend({
	rank: z.number(),
});

export const StockAnalysisResultSchema = z.object({
	markets: z.array(z.string()),
	total: z.number(),
	analyzed: z.number(),
	skipped: z.number(),
	topStocks: z.array(RankedStockAnalysisSchema),
});

export type StockAnalysisResult = z.infer<typeof StockAnalysisResultSchema>;

// TypeScript interfaces

export interface StockAnalysis {
	ticker: string;
	companyName: string;
	market: string;
	analysis: string;
	finalScore: number;
	criteriaAlignment: number;
	financialStrength: number;
	growthPotential: number;
	marketPosition: number;
	contrarianScore: number;
	riskLevel: number;
}

export interface RankedStockAnalysis extends StockAnalysis {
	rank: number;
}

export interface Config {
	marketContext: string;
	preferCriteria: string;
	avoidCriteria: string;
	numMarkets: number;
	numAdditionalMarkets: number;
	numStocksPerMarket: number;
	numTopStocks: number;
	numMaxStocksPerMarket: number;
}

