import Sqlite from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));

interface ColumnInfo {
	name: string;
	type: string | null;
	pk: 0 | 1;
}

interface ForeignKeyInfo {
	table: string;
	from: string;
	to: string;
}

interface IndexInfo {
	name: string;
	unique: 0 | 1;
}

interface IndexColumnInfo {
	name: string;
}

export class Database {
	private db!: Sqlite.Database;

	constructor(
		readonly datasetName: string,
		readonly datasetDescription: string,
		readonly databaseUrl: string
	) { }

	// Loads the database if necessary and opens it
	async open() {
		const dataDir = path.join(BASE_DIR, 'database');
		if (!existsSync(dataDir)) {
			mkdirSync(dataDir, { recursive: true });
		}
		const dbPath = path.join(dataDir, `${this.datasetName}.db`);

		// Download database if it doesn't exist
		if (!existsSync(dbPath)) {
			console.log(
				`Downloading SQLite DB for dataset "${this.datasetName}" from ${this.databaseUrl}...`
			);
			const response = await fetch(this.databaseUrl);
			if (!response.ok) {
				throw new Error(
					`Failed to download DB from ${this.databaseUrl}. HTTP ${response.status} ${response.statusText}`
				);
			}
			const arrayBuffer = await response.arrayBuffer();
			const buffer = Buffer.from(arrayBuffer);
			await fs.writeFile(dbPath, buffer);
			console.log(`Saved DB to ${dbPath}`);
		}

		// Open the database (whether just downloaded or already existed)
		this.db = new Sqlite(dbPath, { readonly: true });
	}

	getDb(): Sqlite.Database {
		return this.db;
	}

	// Extracts structured schema metadata from the database. DB must be opened first.
	getSchemaMetadata() {
		const db = this.getDb();
		const tables = db.prepare<[], { name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
		).all();

		const tableData = tables.map((table) => {
			const tableName = table.name;
			const escaped = tableName.replace(/"/g, '""');
			const pragmaRows = db
				.prepare<[], ColumnInfo>(`PRAGMA table_info("${escaped}")`)
				.all();

			const foreignKeys = db
				.prepare<[], ForeignKeyInfo>(`PRAGMA foreign_key_list("${escaped}")`)
				.all();

			const indexes = db.prepare<[], IndexInfo>(`PRAGMA index_list("${escaped}")`).all();
			const uniqueColumns = new Set<string>();

			// Check if PK is single column
			const pkCols = pragmaRows.filter((c) => c.pk > 0);
			if (pkCols.length === 1) {
				uniqueColumns.add(pkCols[0].name);
			}

			// Check unique indexes
			for (const idx of indexes) {
				if (idx.unique === 1) {
					const idxCols = db
						.prepare<[], IndexColumnInfo>(`PRAGMA index_info("${idx.name}")`)
						.all();
					if (idxCols.length === 1) {
						uniqueColumns.add(idxCols[0].name);
					}
				}
			}

			const fkMap = new Map<string, { target: string; cardinality: '1:1' | '1:Many' }>();
			for (const fk of foreignKeys) {
				const targetCol = fk.to || 'PK';
				const cardinality = uniqueColumns.has(fk.from) ? '1:1' : '1:Many';
				fkMap.set(fk.from, { target: `${fk.table}.${targetCol}`, cardinality });
			}

			return {
				name: tableName,
				columns: pragmaRows.map((col) => {
					// Fetch samples
					let samples: unknown[] = [];
					try {
						const rows = db
							.prepare<[], { val: unknown }>(
								`SELECT DISTINCT "${col.name}" as val FROM "${escaped}" WHERE "${col.name}" IS NOT NULL LIMIT 3`
							)
							.all();
						samples = rows.map((r) => r.val);
					} catch {
						// Ignore errors during sample fetching
					}

					const fkInfo = fkMap.get(col.name);

					return {
						name: col.name,
						type: col.type ?? 'UNKNOWN',
						pk: col.pk === 1,
						fk: fkInfo ? fkInfo.target : undefined,
						cardinality: fkInfo ? fkInfo.cardinality : undefined,
						samples,
					};
				}),
				foreignKeys: foreignKeys.map((fk) => ({
					from: fk.from,
					toTable: fk.table,
					toColumn: fk.to,
				})),
			};
		});

		return {
			datasetName: this.datasetName,
			tables: tableData,
		};
	}

	close(): void {
		this.db.close();
	}
}
