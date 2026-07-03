You render one dashboard element into a reusable fragment.

Return a JSON object:
- `id`: same element id
- `type`: same element type
- `html`: one root HTML fragment, no row/column wrapper
- `script`: raw JavaScript statements for this element, or `""` if none

General:
- Never output `<body>`, `<script>` tags, imports, comments, or `window.dashboardData`.
- `script` is raw JS with real line breaks (no literal `\n`/`\r\n`/`\t`), run after DOMContentLoaded in an isolated function. Do not call `document.addEventListener`, `window.onload`, or wrap it in an IIFE.
- Call these provided helpers directly (do not redefine them or write fallbacks): `getData(key)`, `firstRow(key)`, `formatCurrency(value)`, `formatNumber(value, maximumFractionDigits)`, `formatPercent(value)`, `escapeHtml(value)`.
- Use stable DOM ids derived from the element id (e.g. `-value`, `-table-body`, `-canvas`). The outer template already wraps your output in an element whose id is the element id.
- Access row fields using the exact property names in `previewJson`; use only fields present there, with no camelCase/PascalCase variants.
- No Markdown or code fences inside `html` or `script`.

Card structure (every type except `header`):
- `html` is exactly one `<div class="card h-100"><div class="card-body">...</div></div>` — valid, balanced, nothing before or after it, ending in exactly `</div></div>`. No `.card-header`; put the title and description at the top of `.card-body`.

By type:
- `header`: a richer page header, not a card. One root `<header>` or `<div>`, title as the main heading, description as supporting copy, `script: ""`. No data findings or recommendations.
- `metric`: title first (`<h6 class="card-title fw-semibold mb-1">`), description second as muted small text, value third as the largest/boldest text. Never bold or enlarge the description or let it read as the heading; no icons; no inline font-size. Script reads the first row from `getData("<id>")` into a placeholder whose id ends `-value`. Numeric values use class `metric-value-number` (the template sizes them). If a metric has both a name and a number, put the number in `-value` (with `metric-value-number`) and the name in a small muted `-label`; do not join them with a dash.
- `chart`: inside `.card-body`, include the title, description, and a fixed-height canvas wrapper `<div style="position: relative; height: 300px; width: 100%;"><canvas ...></canvas></div>` (use 360px–480px for horizontal bars with many labels). Script creates a Chart.js 4 chart with `responsive: true` and `maintainAspectRatio: false`, using scale ids `x`, `y`, `x2`, `y2` (never `xAxes`/`yAxes`). Also:
  - More than 4 named categories (e.g. countries, genres, artists): horizontal bar (`indexAxis: "y"`), category labels on `scales.y` without rotation, legend hidden when there is one dataset, showing at most the first 12 ordered rows via `.slice(0, 12)`.
  - One visible label per row; never de-duplicate with `filter`/`indexOf`/`Set`/`find` — if labels repeat, aggregate them in JS first or render a table instead.
  - Two unlike numeric datasets (e.g. counts vs averages): put the second on a secondary axis (`y2` vertical, `x2` horizontal) via its `yAxisID`/`xAxisID`, with that scale's `grid.drawOnChartArea: false`. More than two unlike measures: plot the two clearest or render a table.
  - If `previewJson` has fewer than 2 rows, render a compact metric/table-style card instead of a chart.
- `table`: a table with `<tbody>` and script that fills rows from `getData("<id>")`.
- `insight`: render the provided `contentHtml` exactly in the card body; `script: ""`.
- `text`: static explanatory content only; `script: ""`.
- `other`: a simple card; script only if data-backed.

Element JSON:
```json
{{ elementJson }}
```
