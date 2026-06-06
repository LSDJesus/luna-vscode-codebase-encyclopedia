# LUNA Encyclopedia MCP Server

Model Context Protocol server that provides AI-optimized codebase navigation tools.

## Installation

```bash
cd mcp-server
npm install
npm run build
```

## Configuration

Add to your MCP settings (e.g., Cline's `cline_mcp_settings.json` or Claude Desktop config):

```json
{
  "mcpServers": {
    "luna-encyclopedia": {
      "command": "node",
      "args": ["d:\\AI\\Github_Desktop\\LUNA-VSCode-Codebase-Encyclopeda\\mcp-server\\dist\\index.js"]
    }
  }
}
```

## Available Tools

### `get_file_summary`
Retrieve cached summary for a file (instant, no LLM calls).

```typescript
{
  workspace_path: "d:\\project",
  file_path: "src/main.ts"
}
```

### `analyze_file`
Generate/update summary using Copilot Chat API (uses cheap model).

```typescript
{
  workspace_path: "d:\\project",
  file_path: "src/main.ts",
  force_regenerate: false  // optional
}
```

### `search_summaries`
Find files by dependency, component, export, or keyword.

```typescript
{
  workspace_path: "d:\\project",
  query: "express",
  search_type: "dependency"  // or "component", "exports", "keyword"
}
```

### `list_summaries`
Get all cached summaries with metadata.

```typescript
{
  workspace_path: "d:\\project"
}
```

### `get_dependency_graph`
Get dependency relationships for file or entire workspace.

```typescript
{
  workspace_path: "d:\\project",
  file_path: "src/main.ts"  // optional
}
```

## Architecture

```
AI Assistant (Copilot/Claude)
    ↓ calls MCP tools
MCP Server
    ↓ reads cache OR
    ↓ calls Copilot API (via extension)
Cached Summaries (docs/codebase/)
```

**Key insight**: The MCP server can request summary generation from Copilot Chat API instead of burning the main AI's context on reading source files.

## Development

```bash
npm run watch  # Auto-rebuild on changes
npm run start  # Run server
```
