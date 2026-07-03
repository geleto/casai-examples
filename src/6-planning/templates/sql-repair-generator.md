You are repairing a SQLite SELECT query for a dashboard element.

Your task:
- Write a revised single, syntactically valid SQLite SELECT query that best satisfies the data request.
- Preserve the intent of the data request; do not invent tables, columns, filters, or values that are not supported by the schema summary.
- If the previous query failed, directly fix the reported problem.
- If the previous query returned zero rows, broaden or correct joins, filters, date logic, grouping, or ordering where reasonable.
- If the previous query used a table shown with 0 rows in the schema summary, switch to a relevant non-empty table if one exists.
- If the failed query uses a complex shape such as correlated subqueries, medians, percentiles, ranks, or quartiles, you may simplify the task by replacing optional advanced statistics with direct aggregate evidence such as counts, sums, averages, minimums, or maximums.
- If one optional statistic is causing repeated failure, omit or replace that statistic rather than failing the whole element.
- Do not fix alias or missing-column errors by only renaming aliases when the query structure itself may be the problem.
- Only use tables and columns that appear in the schema summary.
- Use the exact table and column names from the schema summary.
- Do not repair a missing column by substituting an unrelated column, constant value, or alias that still claims to measure the missing field.
- Use SQLite syntax only; avoid functions from other databases.
- Do not use `PERCENTILE_CONT`, `PERCENTILE_DISC`, or `WITHIN GROUP`; they are not portable SQLite syntax.
- For value tiers or quartiles, use SQLite window functions such as `NTILE(4) OVER (ORDER BY metric)` or `ROW_NUMBER()` plus counts.
- Do not use window functions in `WHERE`, `GROUP BY`, or `HAVING`. Compute window values in a CTE/subquery, then filter them in an outer `SELECT`.
- When using `GROUP BY`, every selected column must either be grouped or aggregated.
- Use simple aliases with letters, numbers, and underscores only; do not use spaces or punctuation in aliases.
- With `UNION` or `UNION ALL`, order only by output columns/aliases, or wrap the union in a subquery.
- Do not put `ORDER BY` or `LIMIT` inside individual `UNION` branches unless that branch is wrapped as a subquery.
- Prefer reasonably small result sets suitable for previews (use LIMIT when appropriate).
- If the dashboard element type is `metric`, return exactly one row for one headline value. Use one aggregate row, or `ORDER BY` the main metric with `LIMIT 1` for a top/best category plus its numeric measure. Do not return grouped category comparisons.
- If the dashboard element type is `chart` and the request compares values by a group such as era, decade, region, country, genre, artist, team, publisher, or language, return one row per displayed group. Use `GROUP BY` on the displayed group label or an equivalent subquery/CTE, and aggregate every metric column for that group.
- Do not return raw rows with repeated chart labels for grouped chart requests; repeated labels can collapse into too few plotted points.
- If the dashboard element type is `chart` and the result is grouped by named categories such as countries, genres, artists, customers, teams, publishers, or languages, order by the main metric and use `LIMIT 12`.
- If the dashboard element type is `table`, use `LIMIT 20` unless the request clearly needs fewer rows.
- If the dashboard element type is `insight`, return compact aggregate or ranked evidence, not broad raw rows.
- For charts and tables, preserve the most natural ordering for the visualization, such as chronological order for trends or descending metric order for rankings.
- Do not explain the query.
- Do not surround it with backticks or any other formatting.
- Do not include comments.

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
