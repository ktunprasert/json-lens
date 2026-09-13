# JSON Lens

A dependency-free Chrome/Edge DevTools extension for inspecting network JSON. Open a response, explore a lazy tree, find keys or values, and extract data with JSONPath or a small jq-style language. Processing stays inside the extension.

## Install

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Enable **Developer mode**, choose **Load unpacked**, and select this directory.
3. Open or reopen DevTools on the page you want to inspect.
4. Select **JSON Lens** (possibly under the DevTools `»` overflow menu).
5. Reload the inspected page, then select a captured request.

No install step, bundler, backend, host permissions, or content scripts required. Use a current Chrome/Edge release.

## Workflow

- Requests are captured as long as DevTools is open, even before the JSON Lens panel is selected. Existing requests are seeded from DevTools' HAR log when available.
- Filter requests by URL, method, or status. JSON MIME types are shown by default; uncheck **JSON responses only** for mislabeled responses.
- Click a request, or right-click a request **inside JSON Lens** and choose **Inspect response**.
- Expand tree nodes, search keys/values, or run a query. Tree children load in pages of 80.
- Click a node to copy its path or value. Right-click it for JSONPath, jq-path, and value copying. Keyboard: Shift+F10 opens the same menu.
- **Copy result** copies the displayed JSON. A query with one output displays that value; multiple outputs display a synthetic array; no outputs display `[]`. Paths refer to the displayed result, not necessarily the original response.
- **Pause** stops new capture. **Preserve log** retains entries across navigation. **Clear** releases captured requests and the current inspection.
- **Paste JSON** accepts copied response bodies. **Try sample response** works without a connected inspected page.

### Native Network context-menu limitation

Chrome's public extension APIs do **not** allow adding context-menu entries to native DevTools Network rows or reading its selected request. React DevTools' page/Elements integration does not imply equivalent Network integration.

The supported bridge is the [`chrome.devtools.network`](https://developer.chrome.com/docs/extensions/reference/api/devtools/network) API, providing HAR entries and `Request.getContent()`. JSON Lens maintains its own request picker using that API.

For a response already selected in native Network: **right-click → Copy → Copy response**, then **JSON Lens → Paste JSON**. This imports the body only; it does not replay a request. Requests made before DevTools opened may be unavailable; reload to capture them.

## Query language

Queries always use the original selected/imported response. Blank queries return it unchanged. Unsupported syntax reports an error; queries are parsed and interpreted, never passed to `eval` or `Function`.

### JSONPath subset

| Expression | Meaning |
| --- | --- |
| `$` | Entire response |
| `$.data.users[0]` | Property and array lookup |
| `$["odd.key"]` | Quoted key (single quotes also supported) |
| `$.data.users[-1]` | Last array item |
| `$.data.users[*].name` | Wildcard traversal |
| `$.data.*` | Object values |
| `$..name` / `$..*` | Recursive property / descendant traversal |
| `$.data.users[0:5]` | Array slice, end exclusive |

Missing properties produce no matches. No predicates (`[?()]`), unions, slice steps, or full JSONPath standard compliance.

### jq subset

```jq
.data.users[] | select(.active == true) | .name
.data.users | map(select(.age >= 30) | .name)
.data.users | sort_by(.age) | reverse
[.data.users[] | .name]
.data | keys
.data.users | length
```

Supported: identity `.`, property/index lookup, quoted keys, `[]` iteration, slices, `|`, stream collection `[…]`, literals, parentheses, `map`, `select`, `sort_by`, `keys`, `length`, `type`, `sort`, `reverse`, `== != > >= < <=`, `and`, `or`.

Missing object properties yield `null`. Only `false` and `null` are falsey. Invalid type operations report errors. No object constructors, arithmetic, variables, regex, optional chaining, custom functions, or full jq compatibility.

## Limits and privacy

- Last **300** request entries retained per DevTools session. Bodies are fetched only when selected. Closing DevTools discards the session; nothing is stored on disk or sent to a service.
- Maximum inspected body: **10 MiB** of UTF-8 JSON. Plain JSON only; JSONP, NDJSON, and anti-XSSI-prefixed responses are not automatically rewritten.
- Parsing/querying runs in a dedicated worker with a **2-second timeout**, a **4096-character query limit**, and interpreter work/output limits. After a worker timeout, reselect or reimport the response.
- Search checks at most **100,000 nodes**, returns at most **300 matching nodes**, and traverses at most **256 levels**. Search results show full paths; query first to narrow large responses.
- DevTools may evict response bodies or omit early requests. Preserve log retains request metadata, but cannot guarantee Chrome keeps the underlying bodies.
- The extension does not add a browser-page context menu; its menus are inside its own DevTools panel.

## Development

Node.js 22+ is sufficient for automated checks. No dependencies to install.

```sh
npm test
npm run check
```

Files: `capture.js` owns the session request log; `devtools.js` creates the panel; `panel.js` coordinates UI and worker; `tree.js` renders lazy trees; `query.js` implements the query subset; `worker.js` isolates parsing/query execution.

### Browser smoke check

1. Load unpacked, open DevTools, reload a page that fetches JSON, and confirm requests arrive before first selecting JSON Lens.
2. Select a request; verify status, URL, tree, search, path/value copy, and right-click menus.
3. Run `$.data.users[*].name` against the sample, then `.data.users[] | select(.active) | .name` in jq mode.
4. Try invalid JSON, a non-JSON response, and an invalid query. Errors should remain readable; a failed query retains the prior result.
5. Toggle recording and preserve log; reload and clear. Switch rapidly between requests to confirm stale bodies do not replace the current selection.
