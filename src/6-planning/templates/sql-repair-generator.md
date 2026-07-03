You are repairing a SQLite SELECT for a dashboard element. Return ONLY one corrected, valid SQLite SELECT that best satisfies the data request — no explanation, comments, or backticks.

Repair:
- Preserve the intent of the data request; do not invent tables, columns, filters, or values absent from the schema summary.
- If the previous query errored, fix the reported problem directly. If it returned zero rows, broaden or correct joins, filters, date logic, grouping, or ordering. If it used a table shown with 0 rows, switch to a relevant non-empty table.
- Do not fix a missing-column or alias error by only renaming aliases, or by substituting an unrelated column/constant that still claims to measure the missing field — the query shape may be the real problem.
- If a complex shape (correlated subqueries, medians, percentiles, ranks, quartiles) keeps failing, replace the optional statistic with direct aggregate evidence (counts, sums, averages, min, max) rather than failing the whole element.

Rules:
- Use only tables and columns from the schema summary, with their exact names. SQLite syntax only.
- Do not use `PERCENTILE_CONT`, `PERCENTILE_DISC`, or `WITHIN GROUP`. For value tiers or quartiles use `NTILE(4) OVER (ORDER BY metric)` or `ROW_NUMBER()` plus counts.
- Do not use window functions in `WHERE`, `GROUP BY`, or `HAVING`; compute them in a CTE/subquery, then filter in an outer `SELECT`.
- With `GROUP BY`, every selected column must be grouped or aggregated. Use simple aliases (letters, numbers, underscores only).
- With `UNION`/`UNION ALL`, order only by output columns, or wrap the union in a subquery; do not put `ORDER BY`/`LIMIT` inside a branch unless it is wrapped.
- Prefer small result sets; use `LIMIT` where appropriate.

By element type:
- `metric`: return exactly one row with one headline value; no grouped comparisons.
- `chart`: one row per displayed group via `GROUP BY`, aggregating every metric; for named categories `ORDER BY` the main metric and `LIMIT 12`.
- `table`: `LIMIT 20` unless clearly fewer are needed.
- `insight`: compact aggregate or ranked evidence, not broad raw rows.
- For charts and tables, keep the natural order (chronological for trends, descending metric for rankings).

You are given:
- Dataset description:
{{ datasetDescription }}

- SQLite schema summary:
{{ schemaSummary }}

- Dashboard element type:
{{ elementType }}

- Natural language data request:
{{ dataRequest }}

- Previous SQL query:
{{ previousSql }}

- Execution feedback:
{{ failureReason }}

- Repair attempt:
{{ repairAttempt }}

Return ONLY the SQL SELECT statement.
