import Sqlite from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { unzipSync } from 'fflate';

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii');
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;

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

interface ColumnProfile {
	samples?: unknown[];
	range?: {
		min: unknown;
		max: unknown;
	};
}

export interface SqlExecutionResult {
	ok: boolean;
	rows: unknown[];
	error?: string;
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
		const sqlPath = path.join(dataDir, `${this.datasetName}.sql`);

		// Download database if it doesn't exist, or rebuild it if an older run
		// cached a SQL script at the .db path.
		if (existsSync(dbPath)) {
			const cachedFile = await fs.readFile(dbPath);
			if (!isSqliteDatabase(cachedFile)) {
				if (!looksLikeSqlScript(cachedFile)) {
					throw new Error(
						`Cached database at ${dbPath} is not a valid SQLite database. Delete it and retry the download.`
					);
				}
				console.log(`Cached file at ${dbPath} is a SQL script; rebuilding SQLite DB...`);
				await createDatabaseFromSql(cachedFile.toString('utf-8'), dbPath);
			}
		} else {
			console.log(
				`Downloading SQLite DB for dataset "${this.datasetName}" from ${this.databaseUrl}...`
			);
			const response = await fetch(this.databaseUrl);
			if (!response.ok) {
				throw new Error(
					`Failed to download DB from ${this.databaseUrl}. HTTP ${response.status} ${response.statusText}`
				);
			}
			const downloadedBuffer = await readResponseBuffer(response);
			const buffer = isZipArchive(downloadedBuffer)
				? extractDatabaseFileFromZip(downloadedBuffer)
				: downloadedBuffer;
			if (isSqliteDatabase(buffer)) {
				await fs.writeFile(dbPath, buffer);
				console.log(`Saved DB to ${dbPath}`);
			} else if (looksLikeSqlScript(buffer)) {
				await fs.writeFile(sqlPath, buffer);
				console.log(`Saved SQL script to ${sqlPath}`);
				await createDatabaseFromSql(buffer.toString('utf-8'), dbPath);
				console.log(`Created DB at ${dbPath}`);
			} else {
				throw new Error(
					`Downloaded file from ${this.databaseUrl} is neither a SQLite database nor a SQL script.`
				);
			}
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
			const rowCount = db
				.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM "${escaped}"`)
				.get()?.count ?? 0;
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
				rowCount,
				columns: pragmaRows.map((col) => {
					const fkInfo = fkMap.get(col.name);
					const profile = profileColumn(db, escaped, col, rowCount, Boolean(fkInfo));

					return {
						name: col.name,
						type: col.type ?? 'UNKNOWN',
						pk: col.pk === 1,
						fk: fkInfo ? fkInfo.target : undefined,
						cardinality: fkInfo ? fkInfo.cardinality : undefined,
						samples: profile.samples,
						range: profile.range,
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

	tryExecuteSql(sql: string): SqlExecutionResult {
		console.log(`[Database] Executing SQL:\n${sql}\n`);
		const db = this.getDb();
		try {
			return {
				ok: true,
				rows: db.prepare(sql).all() as unknown[],
			};
		} catch (err: unknown) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			console.error(`SQL Execution failed: ${errorMessage}`);
			return {
				ok: false,
				rows: [],
				error: errorMessage,
			};
		}
	}

	executeSql(sql: string): unknown[] {
		return this.tryExecuteSql(sql).rows;
	}

	close(): void {
		this.db?.close();
	}
}

export type SchemaMetadata = ReturnType<Database['getSchemaMetadata']>;

export function createSchemaMetadataForTables(schemaMetadata: SchemaMetadata) {
	const tableNamesInSchemaOrder = (tableNames: string[]) => {
		const selectedNames = new Set(tableNames.map(name => name.toLowerCase()));
		return schemaMetadata.tables.filter(table => selectedNames.has(table.name.toLowerCase()));
	};
	return (requiredTableNames: string[] = []) => {
		const selectedTables = tableNamesInSchemaOrder(requiredTableNames);
		return selectedTables.length == 0
			? schemaMetadata
			: { ...schemaMetadata, tables: selectedTables };
	};
}

function profileColumn(
	db: Sqlite.Database,
	escapedTableName: string,
	col: ColumnInfo,
	rowCount: number,
	isForeignKey: boolean
): ColumnProfile {
	if (rowCount == 0 || col.pk == 1 || isForeignKey || isIdentifierColumn(col)) return {};

	const escapedColumnName = col.name.replace(/"/g, '""');
	const expression = `"${escapedColumnName}"`;
	try {
		if (isNumericColumn(col) || isDateLikeColumn(col)) {
			const range = db
				.prepare<[], { min: unknown; max: unknown }>(
					`SELECT MIN(${expression}) AS min, MAX(${expression}) AS max FROM "${escapedTableName}" WHERE ${expression} IS NOT NULL`
				)
				.get();
			return range?.min == null && range?.max == null ? {} : { range };
		}

		const rows = db
			.prepare<[], { val: unknown }>(
				`SELECT DISTINCT ${expression} AS val FROM "${escapedTableName}" WHERE ${expression} IS NOT NULL AND TRIM(CAST(${expression} AS TEXT)) <> '' LIMIT 3`
			)
			.all();
		return { samples: rows.map(row => compactSample(row.val)) };
	} catch {
		return {};
	}
}

function isNumericColumn(col: ColumnInfo): boolean {
	return /INT|REAL|FLOA|DOUB|NUM|DEC/i.test(col.type ?? '') && !/id$/i.test(col.name);
}

function isIdentifierColumn(col: ColumnInfo): boolean {
	const name = col.name.toLowerCase();
	return !isDateLikeColumn(col) && (name == 'id' || name.endsWith('_id') || name == 'tsn' || name.endsWith('_tsn'));
}

function isDateLikeColumn(col: ColumnInfo): boolean {
	return /(date|time|year)/i.test(col.name);
}

function compactSample(value: unknown): unknown {
	return typeof value == 'string' && value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

function isSqliteDatabase(buffer: Buffer): boolean {
	return buffer.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER);
}

function isZipArchive(buffer: Buffer): boolean {
	return buffer.length >= 4 && buffer.readUInt32LE(0) == ZIP_LOCAL_FILE_HEADER;
}

async function readResponseBuffer(response: Response): Promise<Buffer> {
	const reader = response.body?.getReader();
	if (!reader) return Buffer.from(await response.arrayBuffer());
	const contentLength = Number(response.headers.get('content-length') ?? 0);
	const chunks: Buffer[] = [];
	let receivedBytes = 0;
	let nextProgressLog = 25 * 1024 * 1024;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = Buffer.from(value);
		chunks.push(chunk);
		receivedBytes += chunk.length;
		if (receivedBytes >= nextProgressLog) {
			console.log(`Downloaded ${formatMegabytes(receivedBytes)}${contentLength ? ` of ${formatMegabytes(contentLength)}` : ''}...`);
			nextProgressLog += 25 * 1024 * 1024;
		}
	}
	return Buffer.concat(chunks, receivedBytes);
}

function formatMegabytes(bytes: number): string {
	return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function extractDatabaseFileFromZip(buffer: Buffer): Buffer {
	console.log('Extracting downloaded ZIP...');
	const files = unzipSync(buffer, {
		filter: file => /\.(db|sqlite|sqlite3|sql)$/i.test(file.name),
	});
	const fileName = Object.keys(files).find(name => /\.(db|sqlite|sqlite3)$/i.test(name))
		?? Object.keys(files).find(name => /\.sql$/i.test(name));
	if (!fileName) {
		throw new Error('Downloaded ZIP did not contain a .db, .sqlite, .sqlite3, or .sql file.');
	}
	const extracted = Buffer.from(files[fileName]);
	if (!isSqliteDatabase(extracted) && !looksLikeSqlScript(extracted)) {
		throw new Error(`ZIP entry "${fileName}" is not a SQLite database or SQL script.`);
	}
	console.log(`Extracted ${fileName} from downloaded ZIP.`);
	return extracted;
}

function looksLikeSqlScript(buffer: Buffer): boolean {
	const prefix = buffer.subarray(0, 4096).toString('utf-8').trimStart().toUpperCase();
	return prefix.startsWith('/*')
		|| prefix.startsWith('--')
		|| prefix.startsWith('CREATE ')
		|| prefix.includes('CREATE TABLE')
		|| prefix.includes('INSERT INTO');
}

async function createDatabaseFromSql(sql: string, dbPath: string): Promise<void> {
	await fs.rm(dbPath, { force: true });
	const db = new Sqlite(dbPath);
	try {
		db.exec(sql);
	} finally {
		db.close();
	}
}
