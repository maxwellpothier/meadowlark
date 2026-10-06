# Meadowlark

Meadowlark is Excalidraw with a sidebar of pages, which Claude Code can also draw on. It runs on your machine: a small local server keeps everything in one SQLite file, and an MCP server lets Claude sessions in any repo read, add and edit pages. It has no account, no cloud and no sync. Each machine (say, a work laptop and a home machine) runs its own instance with its own data. See [docs/decisions/2026-10-01-local-server-and-mcp.md](docs/decisions/2026-10-01-local-server-and-mcp.md) for why.

The editor is the official [`@excalidraw/excalidraw`](https://www.npmjs.com/package/@excalidraw/excalidraw) component (0.18.x), not a reimplementation. Meadowlark adds page management, persistence and the Claude integration around it.

## Run

Requires Node 22.18+ (it runs the server's TypeScript directly and uses the built-in `node:sqlite`).

```sh
npm install
npm run dev        # http://localhost:5173, with hot reload
```

Or run the built app:

```sh
npm run build
npm start          # http://localhost:5173 (PORT=… to change)
```

Or let `scripts/meadowlark.sh` do both: it rebuilds if the source changed since the last build and starts the server. It doesn't open a browser tab, so reload the one you have open. If Meadowlark is already running, it says so and exits. Alias it to type `meadowlark` from anywhere:

```sh
alias meadowlark='/path/to/meadowlark/scripts/meadowlark.sh'
```

Other scripts:

```sh
npm test           # unit tests (store, Claude model, autosave)
npm run typecheck
npm run lint
```

Both `dev` and `start` serve the app and its API from the same address, on `127.0.0.1` only. Excalidraw's fonts are copied into `public/fonts` before `dev` and `build` (by `scripts/copy-fonts.mjs`) and served locally, so the app works offline.

### Data

Everything lives in `~/.meadowlark/` (set `MEADOWLARK_HOME` to use another folder):

- `meadowlark.db` is the SQLite database. The app server and every Claude session's MCP server open it together.
- `backups/` gets a consistent copy of the database when the server starts and then hourly, if anything changed. The newest 48 are kept. Copying the live `.db` file while something writes to it can give a corrupt copy, so these are the files your machine's backup (Time Machine etc.) should rely on.

To restore from one of those, stop the app and replace `meadowlark.db` with it (and delete `meadowlark.db-wal` and `meadowlark.db-shm`).

## Claude

Register the MCP server once per machine, for all repos:

```sh
claude mcp add --scope user meadowlark -- node --disable-warning=ExperimentalWarning /path/to/meadowlark/server/mcp.ts
```

Then, in any Claude Code session, ask for a diagram ("sketch how the auth flow works in Meadowlark") or a change to one ("add the retry step to the pipeline diagram"). The app doesn't need to be running: the MCP server writes to the database directly, and the app picks the change up when it next looks.

Claude doesn't see Excalidraw's JSON. It gets a flat list of shapes (`{ id, type, x, y, width, height, label, start, end, … }`, with a box's text folded into its `label` and an arrow's attachments as ids) and sends edits in the same terms. The MCP tools are:

| tool          | does                                                                                    |
| ------------- | --------------------------------------------------------------------------------------- |
| `list_pages`  | pages, newest first, optionally filtered by name                                        |
| `read_page`   | a page's shapes, including Claude's edits that haven't been applied yet                 |
| `add_page`    | a new page from shapes. Also how Claude does a redo                                     |
| `edit_page`   | remove, update and add shapes on an existing page                                       |
| `revert_page` | undo Claude's latest change: a waiting edit, or else the last applied one               |

The rules:

- **Claude can't delete pages.** It can remove shapes from a page.
- **Big rewrites become new pages.** Claude is told to use `add_page` for a redo, and the server refuses any edit that would remove more than half of a page's shapes.
- **Edits are queued, then applied by the app.** Sizing text needs a browser, so the server stores Claude's edit and the app draws it into real Excalidraw elements (`src/claude/apply.ts`). A page you aren't looking at is updated as soon as the app sees the edit. If the page is open, a banner asks before applying: **Apply** or **Discard**. An empty open page (one Claude just created) is filled in without asking.
- **Every applied change can be reverted.** Before applying, the server snapshots the page. Changed pages get a dot in the sidebar, and opening one shows **Revert** and **Keep**.
- **Claude's pages are marked.** A page Claude created has Claude's spark before its name in the sidebar, and so do duplicates of it.
- **Pages remember which repo created them.** When Claude creates a page, the MCP server records the session's git remote (or repo path). It isn't shown anywhere yet.

## Features

- **Pages sidebar**
  - Create, rename (double-click or the ⋯ menu), duplicate, and delete (with a confirmation).
  - Sorted by most recently changed, so a page you or Claude just changed is at the top.
  - Pin pages from the ⋯ menu to keep them above the rest, most recently pinned first. Pinning doesn't count as a change.
  - Pages Claude makes land in the Inbox at the bottom of the sidebar. Open one and click Keep to move it into your pages. Duplicates of Claude's pages go straight to your pages.
  - Save for later (⋯ menu, or the inbox banner) moves a page out of your main list into the Saved for Later section, most recently saved first. Move to pages brings it back. Neither counts as a change.
  - The Inbox and Saved for Later sections open and close by clicking their headers, like VS Code's panes.
  - Search filters by name.
  - The sidebar can be collapsed.
- **Autosave**
  - Saves 500 ms after you stop changing things, and at least every 5 s while you keep drawing.
  - The footer shows the save state.
  - Pending edits are saved before switching pages, exporting, duplicating, or backing up, and when the tab is hidden or closed.
- **Live updates**: the server pushes an event whenever the data changes, including changes from Claude, and the sidebar refreshes.
- **Images** are stored next to the page. Images that no element uses any more are deleted on save. A save uploads only images the server doesn't have yet.
- **Session restore**: reopens the last page you had open, at the same scroll and zoom.
- **Import / export**
  - Import one or more `.excalidraw` files, each as a new page (header ⬇ button).
  - Export a single page as `.excalidraw` (⋯ menu on the page). This is also how you share a diagram.
  - **Export all** writes one JSON backup with every page and image (header ⋯ menu).
  - **Restore from backup** brings a backup back in.
- **Theme**: Excalidraw's light/dark toggle (menu, or `Shift+Alt+D`) switches the sidebar as well. The theme applies to the whole app, not to individual pages.

## How it fits together

```
server/
  db.ts                   opens the SQLite file (WAL, busy timeout) and migrates it
  store.ts                every read and write, shared by the app API and the MCP server
  api.ts                  the browser's HTTP API, plus /api/events (server-sent change events)
  main.ts                 `npm start`: serves dist/ and the API
  mcp.ts                  the MCP server Claude Code starts (stdio)
  backups.ts              hourly VACUUM INTO copies
  repo.ts                 works out which repo a Claude session is in
src/
  App.tsx                 page list state, sidebar actions, change events, Claude edits, wiring
  claude/model.ts         Claude's view of a page: shapes, edits, validation, arrow geometry (shared with the server)
  claude/apply.ts         turns Claude's edits into Excalidraw elements (browser only)
  editor/Editor.tsx       loads one page and mounts <Excalidraw> (one instance per page id)
  editor/AutoSaver.ts     debounced, change-detecting saver for the open page
  sidebar/                page list, inline rename, search, menus
  ui/ClaudeBanner.tsx     Apply/Discard and Revert/Keep for the open page
  io/files.ts             .excalidraw import/export (uses Excalidraw's loadFromBlob / serializeAsJSON)
  io/backup.ts            all-pages backup build/parse
  storage/types.ts        StorageAdapter interface + page model
  storage/http.ts         StorageAdapter over the local API
  storage/serialized.ts   wrapper that runs storage calls strictly in order
  storage/index.ts        the one place that picks the adapter
  prefs.ts                device-local UI prefs (last page, sort mode, collapsed, theme)
```

### Storage

The UI only talks to `StorageAdapter` (`storage/types.ts`), implemented over HTTP by `storage/http.ts`. On the server, `Store` (`server/store.ts`) does the same operations on SQLite, synchronously, one transaction per write. The browser's API and the MCP server each open their own connection to the same file.

| table       | holds                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `pages`     | metadata the sidebar reads, the scene (`elements`, `appState` as JSON), `repo`, and the pending "Claude changed this" marker |
| `views`     | `{ scrollX, scrollY, zoom }`. Saved separately, so panning doesn't change `updatedAt` or rewrite the scene |
| `files`     | one row per image, keyed by page and file id                                                              |
| `queue`     | Claude's edits waiting for the app to apply them                                                          |
| `snapshots` | page content from before each applied Claude change (the newest 20 per page), for Revert                 |

Excalidraw file ids are content hashes. Because of that, a save only writes images that aren't stored yet and deletes ones that are no longer referenced. Unchanged images are never rewritten.

Only these `appState` fields are saved per page: `viewBackgroundColor`, `gridSize`, `gridStep` and `gridModeEnabled`, plus the viewport above. Selection, tool state, open dialogs and collaborators are never saved.

The server notices writes from other processes (Claude) by polling SQLite's `data_version`, and its own writes directly, and tells open tabs over `/api/events`. If the open page changed underneath the editor (Claude reverted it, or another tab saved it), the editor reloads it.

The API only answers on `localhost` and only to requests carrying an `x-meadowlark` header, so other websites open in your browser can't call it.

### Not losing data

- `serialized()` runs storage calls one at a time, in the order they were made. When you switch pages, the old page's final save is queued before the new page's load, so the load can never return data older than that save.
- `AutoSaver` only records the latest snapshot on each `onChange`. Excalidraw calls `onChange` for pointer moves and selection too. Hashing and comparing happen once per flush, and a flush that finds no change writes nothing. A page also isn't marked as updated just because you opened it.
- On reload or close, the open page is flushed from `beforeunload`. Small saves go out as `keepalive` requests, which the browser finishes after the tab is gone. If content is still being written at that moment, the browser shows its "Leave site?" prompt to give the write time to finish. You'll only see it if you reload or close within about half a second of an edit.
- A late save for a page that was deleted in the meantime does nothing. It doesn't bring the page back.
- Applying Claude's edits checks that the page hasn't been saved since the edits were drawn. If it has, nothing is written, and the edits are drawn again on top of the newer version.

### Backup format

```json
{ "type": "meadowlark-backup", "version": 1, "exportedAt": 0,
  "pages": [{ "id": "…", "name": "…", "createdAt": 0, "updatedAt": 0, "order": 0, "repo": null,
              "elements": [], "appState": {}, "files": {} }] }
```

Restore matches pages by `id`:

- A page in the backup that already exists here is replaced by the backup version.
- A page in the backup that doesn't exist here is added.
- Pages that aren't in the backup are left alone.

## Known limitations

- **Multiple tabs**: two tabs editing the same page at once don't merge. Whichever saves last wins, and the other tab reloads the page when it sees the change.
- **Claude's arrows are straight.** Arrows Claude attaches are routed centre to centre, and moving an attached shape re-routes them straight, dropping any bends you added by hand.
- **Undo history** is per editor session. Switching pages or reloading clears it, the same as in Excalidraw. Claude's changes are undone with Revert, not Ctrl+Z.
- **The Excalidraw library** (saved shapes) isn't saved yet.
- **Pages from the old IndexedDB version** aren't moved over automatically. Use **Export all** in the old version and **Restore from backup** here.

See [docs/later.md](docs/later.md) for ideas we've parked.
