You render one dashboard element into a reusable fragment.

Return a JSON object with:
- `id`: same element id
- `type`: same element type
- `html`: one root HTML fragment, with no row or column wrapper
- `script`: raw JavaScript statements for this element, or an empty string if none

Rules:
- Do not output `<body>`, `<script>`, script tags, imports, comments, or `window.dashboardData`.
- `script` must contain raw JavaScript statements with real line breaks. Do not include escaped newline or tab text such as `\n`, `\r\n`, or `\t`.
- The `script` is run after DOMContentLoaded in an isolated function. Do not call `document.addEventListener`, `window.onload`, or an IIFE.
- Do not define shared helpers. You may call `getData(key)`, `firstRow(key)`, `formatCurrency(value)`, `formatNumber(value, maximumFractionDigits)`, `formatPercent(value)`, and `escapeHtml(value)`.
- Do not write fallback formatter functions. Use the provided helpers directly.
- Use stable internal DOM ids based on the element id, such as appending `-value`, `-table-body`, or `-canvas`.
- The outer dashboard template already provides a wrapper whose id is exactly the element id.
- For every type except `header`, `html` must be exactly one complete root `<div class="card h-100">...</div>`. Do not emit any HTML before or after that root element.
- `html` must be valid, balanced HTML. Never emit stray closing tags.
- Every card must contain exactly one `<div class="card-body">...</div>`, and all visible content must be inside it. The card should end with exactly two closing tags: `</div></div>`.
- Do not use `.card-header`; put the title and description at the top of `.card-body`.
- For `header`: render a richer page header, not a card. Use one root `<header ...>` or `<div ...>`, use the element title as the main heading, the description as supporting copy, and `script: ""`. Do not include data findings or recommendations.
- For `chart`: include the title, description, fixed-height canvas wrapper, and canvas inside the same `.card-body`: `<div class="card h-100"><div class="card-body">...<div style="position: relative; height: 300px; width: 100%;"><canvas ...></canvas></div></div></div>`. Use `height: 360px` to `480px` for horizontal bar charts with many labels. Script must create a Chart with `responsive: true` and `maintainAspectRatio: false`.
- Use Chart.js 4 syntax. In `options.scales`, use scale ids like `x`, `y`, and optionally `x2` or `y2`; never use old `xAxes` or `yAxes` arrays.
- For bar charts with more than 4 named categories, such as countries, genres, artists, customers, teams, publishers, or languages, use a horizontal bar chart with `indexAxis: "y"` so labels remain readable.
- For named-category charts, display at most the first 12 ordered rows with `.slice(0, 12)` before building labels and datasets.
- Each row used in a chart must produce one visible label. Do not de-duplicate labels with `filter`, `indexOf`, `Set`, or `find`; if labels repeat, aggregate them in JavaScript before plotting or render a table instead.
- If a chart has two numeric datasets with different meanings, units, or scales, such as counts and averages, do not plot both on one axis. Use a secondary numeric axis: `y2` for vertical charts or `x2` for horizontal charts, set the second dataset's `yAxisID` or `xAxisID`, and set the secondary scale's `grid.drawOnChartArea` to `false`.
- If a chart has more than two unlike numeric measures, plot only the two clearest measures or render a table instead.
- For horizontal bar charts, category labels belong on `scales.y`; do not set `yAxisID` on datasets unless creating multiple category axes. For a second numeric axis, use `xAxisID` and define an `x2` scale.
- For horizontal bar charts, hide the legend when there is only one dataset and keep category labels on the y-axis without rotation.
- If a chart's `previewJson` has fewer than 2 rows, do not render a Chart.js chart; render the values as a compact metric/table-style card instead.
- For `table`: include a table with `<tbody>` and script that fills rows from `getData("<element id>")`.
- For `metric`: use this visual hierarchy: title first as `<h6 class="card-title fw-semibold mb-1">`, description second as muted small text, value third as the largest/boldest text. Never bold the description, make it larger than the title, or place it where it reads as the heading. Do not add decorative icons.
- Metric script must read the first row from `getData("<element id>")` and update a visible placeholder whose id ends with `-value`.
- Numeric metric values must use class `metric-value-number`; the dashboard template controls their size.
- If a metric has both a category/name and a numeric measure, put the numeric measure in the `-value` placeholder with `metric-value-number`, and put the category/name in a small muted `-label` placeholder. Do not join them with a dash.
- Do not use inline font-size styles for metric values.
- For `insight`: render the provided `contentHtml` exactly in the card body; use `script: ""`.
- For `text`: render static explanatory content only; use `script: ""`.
- For `other`: render a simple card; script only if data-backed.
- Use only fields visible in `previewJson`.
- For data-backed elements, access row fields using the exact property names visible in `previewJson`; do not invent camelCase or PascalCase variants unless those exact fields are present.
- Do not use Markdown or code fences inside `html` or `script`.

Element JSON:
```json
{{ elementJson }}
```
