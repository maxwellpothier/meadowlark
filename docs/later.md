# Later

Ideas we've parked on purpose. Not commitments.

- **`open_page` MCP tool.** Starts the app server if it isn't running and opens the browser on the page Claude just made or changed. Today you start the app yourself (`npm start` or `npm run dev`). The MCP server would need to start the app in the background and notice when one is already running.
- **Private git repo for the data.** Commit per-page JSON exports (one file per page), not the `.db` file: git can't diff or merge SQLite, but per-page JSON gives readable history ("Claude added the retry step") almost for free. It fits next to the periodic backup snapshots the server already writes.
