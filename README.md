# Omeka S MCP server (Gouda Tijdmachine)

An [MCP](https://modelcontextprotocol.io) server that lets Claude Code (or any other MCP
client) read and write the Omeka S REST API of the Gouda Tijdmachine:
<https://www.goudatijdmachine.nl/omeka/api>.

It runs locally over **stdio**: the MCP client starts it as a child process. There is no
HTTP endpoint and nothing to deploy on Apache.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `omeka_search` | read | Search/list items, media, item sets, sites, site pages, vocabularies, properties, resource classes, resource templates, assets and users. Full-text search, property filters by term (`sdo:name`), class by term, template, item set, site, sorting, paging. Returns the total and one page of compact results. |
| `omeka_get` | read | One resource by type + ID, `compact` (simplified values) or `full` (raw JSON-LD). |
| `omeka_get_template` | read | A resource template with per property: term, label, required/private, allowed data types. |
| `omeka_lookup_term` | read | Find properties or resource classes by term, local name or label. |
| `omeka_get_page` | read | A site page by ID or site + slug, with its blocks (by index), public URL and `modified` timestamp. Long block strings are truncated unless asked otherwise. |
| `omeka_create_item` | write | Create an item or item set with template, class, item sets, sites, visibility and values. |
| `omeka_update_resource` | write | Change values (`set` / `add` / `remove` / `annotate` per term), visibility, template, class, item sets or sites of an item, item set or media. Always GET + merge + PUT. |
| `omeka_add_media` | write | Attach media to an item via the `url`, `iiif` or `html` ingester. |
| `omeka_create_page` | write | Create a site page, optionally with blocks. |
| `omeka_update_page` | write | Change a page's title, slug, visibility, layout and blocks (replace all, or append/insert/replace/update/delete/move by index). Always GET + modify + PUT, with an optional `expect_modified` guard. |
| `omeka_delete` | write | Permanently delete an item, item set, media or site page. |

Write tools are only registered when an API key is configured and `OMEKA_READ_ONLY` is not set.
Every write is followed by a read-back; values Omeka silently dropped are returned under
`warnings`.

## Requirements

- Node.js ≥ 20.6 (for `--env-file`; this server runs Node 24) and npm.
- Network access to the Omeka S API.
- An Omeka S API key (see below). Without a key the server still starts, read-only and anonymous.

## Omeka user & API key requirements

An API key always belongs to an Omeka user and has exactly that user's permissions.

**Creating a key**: log in to the Omeka admin → *Users* → edit the user → tab *API keys* →
enter a label → *Save*. The **key_identity** and **key_credential** are shown once; copy
them straight into `.env`.

**Reads use the key too.** On this installation anonymous API responses are rewritten by the
RdfDispatch setup (no `o:` fields such as `o:id`, `o:resource_template`), and private
resources are invisible without a key. The read tools depend on those fields.

**Which role do you need?** (Omeka S core roles)

| Role | Read (incl. private) | Create items/media | Edit/delete own resources | Edit/delete resources of others | Vocabularies, templates, sites |
|---|---|---|---|---|---|
| Researcher | yes | – | – | – | – |
| Author | yes | yes | yes | – | – |
| Reviewer | yes | yes | yes | edit only | – |
| Editor | yes | yes | yes | yes | – |
| Site admin | yes | yes | yes | yes | sites |
| Global admin | yes | yes | yes | yes | yes |

Recommendations:

- For the write tools use a **dedicated user with role *Editor***. *Author* is not enough:
  almost all existing items are owned by user 2 ("Gouda Tijdmachine Beheerder"), and authors
  can only edit their own resources. New items are owned by the key's user.
- With the Teams module enabled, the user must also be a member of the team that owns the
  resources (and have a team role that allows editing).
- For read-only use, a *Researcher* key plus `OMEKA_READ_ONLY=1` is sufficient.
- `OMEKA_READ_ONLY=1` also hides the write tools when you reuse a more powerful key.
- A permission error is returned as `HTTP 403` with a pointer to this section.

## Install & build

```bash
git clone https://github.com/gouda-tijdmachine/Omeka-S-local-MCP-server.git
cd Omeka-S-local-MCP-server   # on the GTM server this lives in /home/http/goudatijdmachine.nl/mcp
npm ci                        # or: npm install
cp .env.example .env
chmod 600 .env                # the file contains the API credential
$EDITOR .env                  # fill in OMEKA_KEY_IDENTITY and OMEKA_KEY_CREDENTIAL
npm run build                 # compiles src/ to dist/
npm test                      # unit tests + a read-only live test (skipped without .env)
```

`.env` settings:

| Variable | Default | Meaning |
|---|---|---|
| `OMEKA_API_URL` | `https://www.goudatijdmachine.nl/omeka/api` | API base URL, no trailing slash |
| `OMEKA_KEY_IDENTITY` | – | API key identity |
| `OMEKA_KEY_CREDENTIAL` | – | API key credential |
| `OMEKA_READ_ONLY` | `0` | `1` registers the read tools only |
| `OMEKA_READBACK_DELAY_MS` | `1500` | Wait before the read-back after a write (database replica lag) |

The directory is outside every Apache DocumentRoot, so `.env` is not reachable over the web.
Keep it that way if you move the server.

## Run / try it out

The server talks JSON-RPC on stdin/stdout and waits for a client, so running it directly only
shows the startup line on stderr:

```bash
npm start                     # = node --env-file=.env dist/server.js
npm run dev                   # same, from the TypeScript sources via tsx (no build needed)
```

To click through the tools interactively, use the MCP Inspector (opens a local web UI):

```bash
npx @modelcontextprotocol/inspector node --env-file=.env dist/server.js
```

## Register in Claude Code

**Project scope** (only when Claude Code is started in `/home/http/goudatijdmachine.nl` or
below): create `/home/http/goudatijdmachine.nl/.mcp.json`:

```json
{
  "mcpServers": {
    "omeka-gtm": {
      "command": "node",
      "args": [
        "--env-file=/home/http/goudatijdmachine.nl/mcp/.env",
        "/home/http/goudatijdmachine.nl/mcp/dist/server.js"
      ]
    }
  }
}
```

Claude Code asks once to approve project MCP servers from `.mcp.json`.

**User scope** (available in every directory):

```bash
claude mcp add omeka-gtm --scope user -- \
  node --env-file=/home/http/goudatijdmachine.nl/mcp/.env \
  /home/http/goudatijdmachine.nl/mcp/dist/server.js
```

Then restart Claude Code and check with `/mcp` that `omeka-gtm` is connected and lists its
tools. The API key stays in `.env`; it never ends up in `.mcp.json` or `~/.claude.json`.

After changing the code: `npm run build`, then reconnect the server via `/mcp` (or restart
Claude Code).

**Claude Desktop** (same machine): add the same `command`/`args` block under `mcpServers` in
`claude_desktop_config.json`.

## Value notation

The write tools accept, and the read tools return, property values in a simplified notation,
keyed by term:

```json
{
  "dcterms:title":     [{ "value": "Markt", "lang": "nl" }],
  "owl:sameAs":        [{ "uri": "https://n2t.net/ark:/60537/b03ms0m" }],
  "sdo:url":           [{ "uri": "https://example.org/", "label": "Example" }],
  "sdo:isPartOf":      [{ "resource": 3076353 }],
  "sdo:about":         [{ "resource": 2, "type": "resource:itemset" }],
  "sdo:datePublished": [{ "value": "1917-12-01", "type": "numeric:timestamp" }],
  "sdo:geo":           [{ "value": "52.0115,4.7105", "type": "geography:coordinates" }],
  "sdo:keywords":      [{ "value": "intern", "public": false }]
}
```

- No `type`: `resource` → `resource:item`, `uri` → `uri`, otherwise `literal`.
- Any other data type (custom vocab `customvocab:<id>`, `numeric:*`, `geography:*`,
  `geometry:*`, value suggest, ...) is passed as `type`. Use `omeka_get_template` to see the
  allowed data types of a property.
- `lang` on a URI value is stored as the URI's language (`o:lang`).
- Read output adds `title` to resource links and omits `type` when it is the default.

### Value annotations

Any value can carry an `annotation`: property values *about that value*, keyed by term, in
the same notation (Omeka S 4 value annotations, `@annotation` in the API). Typical use is the
source of a statement:

```json
{
  "sdo:description": [{
    "value": "Vermeld in 1757", "lang": "nl",
    "annotation": {
      "prov:hadPrimarySource": [{ "resource": 266234 }],
      "sdo:citation": [{ "uri": "https://gis.gouda.nl/geoserver/wfs", "label": "Gemeente Gouda, GIS-laag", "lang": "nl" }]
    }
  }]
}
```

Annotations cannot be nested. Read tools return them the same way.

Updating, per term:

```json
{
  "sdo:keywords": { "mode": "add",    "values": [{ "value": "Markt", "lang": "nl" }] },
  "sdo:name":     { "mode": "set",    "values": [{ "value": "Grote Markt", "lang": "nl" }] },
  "sdo:text":     { "mode": "remove", "values": [] }
}
```

`remove` with values removes only those values (matched on value + language, URI, or linked
resource ID); with an empty list it removes the term entirely.

Existing annotations are always kept by `add`, `remove` and by updates of other terms. `add`
skips a value that already exists, including any annotation given with it. To change the
annotation of an existing value use `annotate`: the value is matched the same way as for
`remove`, its annotation is replaced by the given one, and omitting `annotation` removes it:

```json
{
  "sdo:description": { "mode": "annotate", "values": [
    { "value": "Vermeld in 1757", "lang": "nl", "annotation": { "prov:hadPrimarySource": [{ "resource": 310639 }] } },
    { "value": "Tweede omschrijving", "lang": "nl" }
  ] }
}
```

## Site pages and blocks

Pages are addressed by ID or by site (ID or slug, e.g. `data`) + page slug. Blocks have no ID
in the API; they are addressed by their **0-based index** in the page, as shown by
`omeka_get_page`.

A block in simplified notation:

```json
{
  "layout": "html",
  "data": { "html": "<p>Text</p>" },
  "layout_data": { "grid_column_position": "auto", "grid_column_span": "12" },
  "attachments": [{ "item": 123, "media": 456, "caption": "Caption" }]
}
```

`data` depends on the layout: `{"html": ...}` for `html`, `{"markdown": ...}` for
`markdown` (the module adds `html` and `fingerprint` itself), `{}` for `pageTitle`, and the
module-specific keys for `geoJsonMap`, `sparql`, `browsePreview`, `verhaalhalen`, ... Copy the
shape from an existing block of the same layout (`omeka_get_page` with `block_index`).

Editing blocks with `omeka_update_page`, operations run in order and each index refers to the
list as it is at that moment:

```json
{
  "id": 73,
  "expect_modified": "2025-11-08T23:35:17+00:00",
  "block_ops": [
    { "op": "update",  "index": 2, "data": { "html": "<p>New text</p>" } },
    { "op": "append",  "block": { "layout": "markdown", "data": { "markdown": "## Sources" } } },
    { "op": "move",    "index": 3, "to": 1 },
    { "op": "delete",  "index": 0 }
  ]
}
```

`update` merges the given `data`/`layout_data` keys into the block and replaces its
attachments only when given; `replace` swaps in a whole new block; `blocks` (instead of
`block_ops`) replaces all blocks. Pass the `modified` value from `omeka_get_page` as
`expect_modified`: pages are sometimes edited by hand in the admin, and the update is refused
when the page changed in between. New pages are not added to the site navigation.

## Design choices & Omeka pitfalls

- **Never PATCH.** Omeka's value hydrator treats a PATCH that contains property values as a
  full replacement of *all* values: every value not included is deleted (including
  `owl:sameAs`/ARK permalinks). `omeka_update_resource` therefore always does GET → merge →
  PUT of the complete representation, and the client has no PATCH method at all. Media,
  item sets, owner and all unmentioned terms are sent back unchanged.
- **Read-back verification.** Omeka silently drops values with an unknown or invalid data
  type instead of returning an error. After each write the resource is fetched again and every
  value that was sent but is not stored is listed under `warnings`.
- **Replica lag.** Reads directly after a write can hit a database replica that is a moment
  behind; the read-back waits `OMEKA_READBACK_DELAY_MS` first.
- **Pages: PUT re-saves every block.** A PATCH with `o:block` *appends* blocks, so pages are
  always updated with GET + modify + PUT of the whole page. That re-saves all blocks, also the
  ones you did not touch, and each block layout's save hook runs again. The core `html` layout
  passes its HTML through HTMLPurifier **when the global setting `use_htmlpurifier` is on**,
  which strips inline `<style>` and `<script>`. Several pages here depend on inline code
  (e.g. Hofstedegeldnummers, page 73; Goudse archivarissen). On this installation the setting
  is off (checked 2026-10-17: `setting.use_htmlpurifier = "0"`; a test page with a `<script>`
  block survived two saves unchanged). As a safety net the read-back compares every block,
  touched or not, with what was sent and reports any change under `warnings`. If you ever
  switch the purifier on, do not edit such pages through the API.
- **Deletes that report an error.** On this installation the Comment module used to throw an
  HTTP 500 after an item was already deleted. `omeka_delete` therefore checks with a GET
  after a 5xx and reports the resource as deleted if it is gone.
- **Terms instead of IDs.** Property and class terms are resolved to IDs via a per-process
  cache of `/properties` and `/resource_classes`. A new property or class added in Omeka is
  picked up after reconnecting the server.
- **Small responses.** Search results omit values unless `include_values` is set, paging is
  explicit (max 100 per page), and the JSON-LD `@context` is stripped.
- **stdio only.** Logging goes to stderr; stdout is reserved for MCP messages.

## Project layout

```
src/server.ts        entry point: configuration, tool registration, stdio transport
src/omeka.ts         API client (key on every request, PHP-style query serialisation)
src/terms.ts         term <-> ID cache for properties and resource classes
src/values.ts        simplified value notation (incl. annotations), merge logic, read-back check, compact output
src/pages.ts         simplified block notation, block operations, page read-back check
src/tools/read.ts    read tools
src/tools/write.ts   write tools
src/tools/pages.ts   site page tools (read + write)
tests/               unit tests (values, annotations, blocks, query building) and a live read-only stdio test
```

## TODO

- [ ] Bulk update tool (same term update on all results of a search, with dry run)
- [ ] Item set membership by search (add/remove many items at once)
- [x] Site pages and page blocks
- [x] Value annotations (`@annotation`) in the simplified notation
- [ ] Add pages to / remove pages from the site navigation
- [ ] Media file upload from a local path (multipart)
- [ ] Automatic data type for `resource` links that point to item sets or media
- [ ] Resource template validation (required properties, allowed data types) before writing
