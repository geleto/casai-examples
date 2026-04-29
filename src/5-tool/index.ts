/**
 * TOOL USE EXAMPLE
 *
 * Demonstrates how to create tools that an LLM can use to answer queries.
 * Shows both API-based tools and LLM-powered tools working together.
 *
 * HOW IT WORKS:
 * 1. The agent receives a natural language query about weather
 * 2. A geocoding tool converts location names to coordinates and timezone
 * 3. An LLM-powered tool interprets natural language time references ("next Friday")
 * 4. A weather API tool fetches current data or forecasts based on location and time
 * 5. The agent synthesizes all data into a natural language response
 *
 * KEY CONCEPTS:
 * - Creating functional tools from existing APIs
 * - Building "LLM-as-a-tool" for complex interpretation tasks
 * - Orchestrating multiple tools in a single chain
 * - Multi-step reasoning with context passing (location -> time -> weather)
 */

import { create, z } from 'casai';
import { advancedModel, basicModel, providerOptions } from '../setup';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { stepCountIs } from 'ai';

// Tool 1: LLM-powered time interpreter
const timeInterpreterTool = create.ObjectGenerator.withTemplate.asTool({
	model: advancedModel,
	providerOptions,
	context: {
		getCurrentTime: () => new Date().toISOString()
	},
	prompt: `Current UTC time: {{ getCurrentTime() }}
UTC offset at destination: {{ utcOffset }}

Calculate the local time at destination by adding the offset to UTC time.
For example: if UTC is 22:00 and offset is +1, local time is 23:00.

Parse this time reference: "{{ timeString }}"

Determine how many days from now (in destination's local time) it represents:
- For "today", "now", "currently": 0 days from now
- For "tonight", "this evening": 0 days from now
- For "tomorrow": 1 day from now
- For "day after tomorrow": 2 days from now
- For specific days like "Monday", "next Friday": calculate days from current local date
- For "this week", "next week": use the nearest relevant date

Return days from now (0-7) and a human-readable interpretation.`,
	schema: z.object({
		daysFromNow: z.number().min(0).max(7).describe('Number of days from today (0-7)'),
		interpretation: z.string().describe('Human-readable interpretation')
	}),
	description: 'Interprets natural language time references relative to the destination timezone.',
	inputSchema: z.object({
		timeString: z.string().describe('Natural language time reference'),
		utcOffset: z.string().describe('UTC offset at destination (e.g., "+1", "-5")')
	})
});

// Tool 2: Convert location name to coordinates, or use server location if not specified
const geocodeTool = create.Function.asTool({
	description: 'Converts a location name to coordinates (latitude, longitude, and UTC offset). If location is empty or not provided, uses the server\'s location based on IP geolocation.',
	inputSchema: z.object({
		location: z.string().optional().describe('Location name (e.g., "London", "Paris, France"). Leave empty to use server location.')
	}),
	execute: async ({ location }: { location?: string }) => {
		let lat: number;
		let lon: number;
		let displayName: string;

		// If no location specified, use server location via IP geolocation
		if (!location) {
			const ipResponse = await fetch('https://ipapi.co/json/');

			if (!ipResponse.ok) {
				throw new Error(`IP geolocation failed: ${ipResponse.statusText}`);
			}

			const ipData = await ipResponse.json() as {
				latitude: number,
				longitude: number,
				city: string,
				region: string,
				country_name: string
			};

			lat = ipData.latitude;
			lon = ipData.longitude;
			displayName = `${ipData.city}, ${ipData.region}, ${ipData.country_name} (server location)`;
		} else {
			// Get coordinates from Nominatim for specified location
			const geoResponse = await fetch(
				`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`,
				{ headers: { 'User-Agent': 'CasaiWeatherExample/1.0' } }
			);

			if (!geoResponse.ok) {
				throw new Error(`Geocoding failed: ${geoResponse.statusText}`);
			}

			const geoData = await geoResponse.json() as { lat: string, lon: string, display_name: string }[];
			if (!Array.isArray(geoData) || geoData.length === 0) {
				throw new Error(`Location not found: ${location}`);
			}

			lat = parseFloat(geoData[0].lat);
			lon = parseFloat(geoData[0].lon);
			displayName = geoData[0].display_name;
		}

		// Get timezone offset from Open-Meteo for the determined coordinates
		const tzResponse = await fetch(
			`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&timezone=auto`
		);

		if (!tzResponse.ok) {
			throw new Error(`Timezone fetch failed: ${tzResponse.statusText}`);
		}

		const tzData = await tzResponse.json() as { utc_offset_seconds: number };
		const offsetHours = tzData.utc_offset_seconds / 3600;
		const utcOffset = offsetHours >= 0 ? `+${offsetHours}` : `${offsetHours}`;

		return {
			lat,
			lon,
			displayName,
			utcOffset
		};
	}
});

// Tool 3: Fetch weather data for coordinates
const weatherFetchTool = create.Function.asTool({
	description: 'Fetches weather data. Use daysFromNow=0 for current weather, 1-7 for daily forecast. Weather codes: 0=clear, 1-3=cloudy, 45-48=fog, 51-67=rain, 71-86=snow, 95-99=thunderstorm',
	inputSchema: z.object({
		lat: z.number().describe('Latitude'),
		lon: z.number().describe('Longitude'),
		daysFromNow: z.number().min(0).max(7).describe('Days from now: 0=current, 1-7=daily forecast')
	}),
	execute: async ({ lat, lon, daysFromNow }: { lat: number, lon: number, daysFromNow: number }) => {
		if (daysFromNow === 0) {
			// Fetch current weather
			const response = await fetch(
				`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&temperature_unit=celsius&timezone=auto`
			);

			if (!response.ok) {
				throw new Error(`Weather API failed: ${response.statusText}`);
			}

			const data = await response.json() as { current: { temperature_2m: number, relative_humidity_2m: number, precipitation: number, weather_code: number, wind_speed_10m: number } };
			return {
				temperature: data.current.temperature_2m,
				humidity: data.current.relative_humidity_2m,
				precipitation: data.current.precipitation,
				weatherCode: data.current.weather_code,
				windSpeed: data.current.wind_speed_10m,
				isForecast: false
			};
		} else {
			// Fetch daily forecast
			const response = await fetch(
				`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code&temperature_unit=celsius&timezone=auto&forecast_days=${daysFromNow + 1}`
			);

			if (!response.ok) {
				throw new Error(`Weather API failed: ${response.statusText}`);
			}

			const data = await response.json() as { daily: { time: string[], temperature_2m_max: number[], temperature_2m_min: number[], precipitation_sum: number[], weather_code: number[] } };

			if (!Array.isArray(data.daily.time) || data.daily.time.length <= daysFromNow) {
				throw new Error('Forecast data not available for requested day');
			}

			return {
				date: data.daily.time[daysFromNow],
				temperatureMax: data.daily.temperature_2m_max[daysFromNow],
				temperatureMin: data.daily.temperature_2m_min[daysFromNow],
				precipitation: data.daily.precipitation_sum[daysFromNow],
				weatherCode: data.daily.weather_code[daysFromNow],
				isForecast: true
			};
		}
	}
});

// Agent that uses all three tools to answer weather queries
const weatherAssistant = create.TextGenerator({
	model: basicModel,
	providerOptions,
	system: `You are a weather assistant. Answer weather questions using these tools in order:

1. Use geocodeTool to get coordinates and UTC offset for the location
   - If the user specifies a location, pass it to geocodeTool
   - If no location is mentioned, omit the location parameter to use server location
2. If the query mentions time (tomorrow, tonight, next Monday, etc.), use timeInterpreterTool with the UTC offset to get daysFromNow
3. Use weatherFetchTool with the daysFromNow value (0 for current, 1-7 for forecast)
4. Provide clear, friendly answers with temperature and conditions

Weather data format:
- Current weather (isForecast=false): has temperature, humidity, precipitation, weatherCode, windSpeed
- Forecast (isForecast=true): has date, temperatureMax, temperatureMin, precipitation, weatherCode`,
	tools: { timeInterpreterTool, geocodeTool, weatherFetchTool },
	stopWhen: stepCountIs(10)
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const query = readFileSync(join(__dirname, 'input.txt'), 'utf-8').trim();

console.log('TOOL USE EXAMPLE\nDemonstrates how to create tools that an LLM can use to answer queries.\n');
console.log(`Query: ${query}\n`);

const result = await weatherAssistant(query);

console.log(`\nAnswer: ${result.text}\n`);
