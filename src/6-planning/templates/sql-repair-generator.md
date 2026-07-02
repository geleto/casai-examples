You are repairing a SQLite SELECT query for a dashboard element.

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

Your task:
- Write a revised single, syntactically valid SQLite SELECT query that best satisfies the data request.
- Preserve the intent of the data request; do not invent tables, columns, filters, or values that are not supported by the schema summary.
- If the previous query failed, directly fix the reported problem.
- If the previous query returned zero rows, broaden or correct joins, filters, date logic, grouping, or ordering where reasonable.
- Only use tables and columns that appear in the schema summary.
- Use the exact table and column names from the schema summary.
- Use SQLite syntax only; avoid functions from other databases.
- Do not use `PERCENTILE_CONT`, `PERCENTILE_DISC`, or `WITHIN GROUP`; they are not portable SQLite syntax.
- For value tiers or quartiles, use SQLite window functions such as `NTILE(4) OVER (ORDER BY metric)` or `ROW_NUMBER()` plus counts.
- Do not use window functions in `WHERE`, `GROUP BY`, or `HAVING`. Compute window values in a CTE/subquery, then filter them in an outer `SELECT`.
- When using `GROUP BY`, every selected column must either be grouped or aggregated.
- Use simple aliases with letters, numbers, and underscores only; do not use spaces or punctuation in aliases.
- With `UNION` or `UNION ALL`, order only by output columns/aliases, or wrap the union in a subquery.
- Do not put `ORDER BY` or `LIMIT` inside individual `UNION` branches unless that branch is wrapped as a subquery.
- Prefer reasonably small result sets suitable for previews (use LIMIT when appropriate).
- If the dashboard element type is `insight`, return compact aggregate or ranked evidence, not broad raw rows.
- For charts and tables, preserve the most natural ordering for the visualization, such as chronological order for trends or descending metric order for rankings.
- Do not explain the query.
- Do not surround it with backticks or any other formatting.
- Do not include comments.

Return ONLY the SQL SELECT statement.
