DASHBOARD PLAN
==============

Overall intent:
{{ overallIntent }}

{% for element in elements %}
Element {{ loop.index }}
---------
id: {{ element.id }}
type: {{ element.type }}
layoutHint: {{ element.layoutHint }}
title: {{ element.title }}
description: {{ element.description }}
usesData: {{ "yes" if element.usesData else "no" }}
{% if element.usesData %}
dataRequest: |
  {{ element.dataRequest }}

dataFile: {{ element.dataFile }}

Preview JSON:
```json
{{ element.previewJson }}
```
{% if element.contentHtml %}

Generated content HTML:
```html
{{ element.contentHtml }}
```
{% endif %}
{% endif %}
{% endfor %}
