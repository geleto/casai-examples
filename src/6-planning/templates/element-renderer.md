You render one dashboard element into a reusable fragment.

Element JSON:
```json
{{ elementJson }}
```

Return a JSON object with:
- `id`: same element id
- `type`: same element type
- `html`: one root HTML fragment, with no row or column wrapper
- `script`: raw JavaScript statements for this element, or an empty string if none

Rules:
- Do not output `<body>`, `<script>`, script tags, imports, comments, or `window.dashboardData`.
- The `script` is run after DOMContentLoaded in an isolated function. Do not call `document.addEventListener`, `window.onload`, or an IIFE.
- Do not define shared helpers. You may call `getData(key)`, `firstRow(key)`, `formatCurrency(value)`, `formatNumber(value, maximumFractionDigits)`, `formatPercent(value)`, and `escapeHtml(value)`.
- Do not write fallback formatter functions. Use the provided helpers directly.
- Use stable internal DOM ids based on the element id, such as appending `-value`, `-table-body`, or `-canvas`.
- The outer dashboard template already provides a wrapper whose id is exactly the element id.
- For every type except `header`, `html` must be exactly one complete root `<div class="card h-100">...</div>`.
- Every card must contain exactly one `<div class="card-body">...</div>`, and all visible content must be inside it.
- Do not use `.card-header`; put the title and description at the top of `.card-body`.
- For `header`: render a richer page header, not a card. Use one root `<header ...>` or `<div ...>`, use the element title as the main heading, the description as supporting copy, and `script: ""`. Do not include data findings or recommendations.
- For `chart`: include a fixed-height canvas wrapper: `<div style="position: relative; height: 300px; width: 100%;"><canvas ...></canvas></div>`. Script must create a Chart with `responsive: true` and `maintainAspectRatio: false`.
- If a chart's `previewJson` has fewer than 2 rows, do not render a Chart.js chart; render the values as a compact KPI/table-style card instead.
- For `table`: include a table with `<tbody>` and script that fills rows from `getData(dataKey)`.
- For `kpi`: use this visual hierarchy: title first as `<h6 class="card-title fw-semibold mb-1">`, description second as muted small text, value third as the largest/boldest text. Never bold the description, make it larger than the title, or place it where it reads as the heading. Do not add decorative icons.
- KPI script must read the first row from `getData(dataKey)` and update a visible placeholder whose id ends with `-value`.
- Numeric KPI values must use class `kpi-value-number`; the dashboard template controls their size.
- If a KPI has both a category/name and a numeric measure, put the numeric measure in the `-value` placeholder with `kpi-value-number`, and put the category/name in a small muted `-label` placeholder. Do not join them with a dash.
- Do not use inline font-size styles for KPI values.
- For `insight`: render the provided `contentHtml` exactly in the card body; use `script: ""`.
- For `text`: render static explanatory content only; use `script: ""`.
- For `other`: render a simple card; script only if data-backed.
- Use only fields visible in `previewJson`.
- Do not use Markdown or code fences inside `html` or `script`.
