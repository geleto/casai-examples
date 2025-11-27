import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pathsToDelete = [
	path.join(__dirname, '../src/14-rag/vectra_index'),
];

async function clean() {
	console.log('Cleaning generated data...');

	for (const p of pathsToDelete) {
		try {
			await fs.rm(p, { recursive: true, force: true });
			console.log(`Deleted: ${p}`);
		} catch (error) {
			console.error(`Error deleting ${p}:`, error);
		}
	}

	console.log('Clean complete.');
}

clean();
