# LUNA Codebase Encyclopedia

**Agent-First Context API** - Generate structured summaries of your codebase for instant, zero-token Copilot Agent queries, plus educational code breakdowns and complete API reference documentation.

## Project Stats

**Current Codebase:**
- **Version:** 1.2.0
- **Architecture:** 
  - **VS Code Extension** (32 TypeScript files)
  - **MCP Server** (5 TypeScript files)
  - **18 MCP Tools** for Copilot Agent Mode
  - **15 User Commands** via Command Palette
  - **Documentation** (24 Markdown files)
  - **Configuration** (29 JSON files + prompts)

## What It Does

LUNA analyzes your code and generates **three types of documentation**:

### 1. Encyclopedia Summaries (For AI Agents)
Structured summaries (Markdown + JSON) that Copilot agents can query instantly without burning tokens.

```
1. Generate summaries once → Structured MD + JSON in .codebase/
2. Open Copilot Chat (Ctrl+I)
3. Ask: "What does extension.ts do?"
4. Copilot queries summaries (instant, zero tokens!)
```

### 2. API Reference (For Development Speed - NEW!)
Automatic extraction of ALL API endpoints with complete request/response schemas.

```
After generation:
Ask Copilot: "What's the endpoint for updating characters?"
→ Instantly get: path, method, request schema, response schema, auth requirements
No more grep → read → guess → grep again!
```

### 3. Code Breakdowns (For Learning)
Line-by-line educational explanations that teach you how your code works.

```
Right-click any file → "LUNA: Explain This Code"
→ Generates detailed breakdown with explanations, examples, and gotchas
→ Adjustable verbosity (Beginner/Intermediate/Expert)
```

**What you get:**
- Human-readable markdown summaries with line numbers
- Machine-readable JSON for AI agent queries  
- **Complete API reference (endpoints, schemas, auth)** (NEW!)
- Educational code breakdowns
- Bidirectional dependency graphs ("uses X" + "used by Y")
- Code complexity analysis + refactoring guidance
- Dead code detection with AST-based analysis
- Smart architecture component mapping
- Quality assurance reviews
- **Multi-language support (Python, TypeScript, Java, C#, Go, JavaScript)**
- **Chat session backup & activity logging** (NEW in v1.2.0!)
- **Async worker agents for parallel task delegation**

## Quick Start

### 1. Initialize
```
Command Palette (Ctrl+Shift+P) → "LUNA: Initialize Workspace"
```

### 2. Generate Summaries
```
"LUNA: Generate Codebase Summaries"
(takes 2-10 minutes depending on project size)
```

### 3. Query with Copilot
```
Open Copilot Chat (Ctrl+I) → Switch to Agent Mode
Ask: "What's the architecture?" or "Which files are most complex?"
Copilot instantly answers from your summaries
```

### 4. Query API Endpoints (NEW!)
```
Ask Copilot: "Show me all POST endpoints"
→ #get_api_reference filter_method="POST"

Ask: "What's the endpoint for updating characters?"
→ #search_endpoints query="update" search_in="description"
→ Instant: path, method, request schema, response schema, auth
```

### 5. Learn Your Code
```
Right-click any file → "LUNA: Explain This Code"
Choose verbosity: Beginner (full detail) / Intermediate / Expert
Get a complete educational breakdown saved as filename.breakdown.md
```

### 6. Keep Summaries Fresh
```
After committing code changes:
Command Palette → "LUNA: Update Stale Summaries"
(Only regenerates modified files - much faster!)
```

### 7. Reset If Needed (NEW!)
```
Command Palette → "LUNA: Reset .codebase Directory"
→ Safely delete all summaries and start fresh
```

**Pro Tip**: LUNA automatically watches for git commits from ANY source (terminal, GitHub extension, VS Code UI, etc.) and prompts you to update summaries. No manual setup needed!

## Async Worker Agent System (v1.1.21) - FULLY AUTONOMOUS & PRODUCTION-READY!

LUNA now features **fully autonomous worker agents** with complete tool access and proven reliability in production.

**How it works:**
- Main AI agent (like Luna in Copilot Chat) spawns background workers
- **Workers have FULL tool access** - they can read files, write files, search code, and use ANY VS Code tool
- Workers run multi-turn conversations (up to 20 turns) to complete complex tasks autonomously
- Workers see results of their actions and can adapt, retry, or fix issues
- **File creation works flawlessly** via intelligent JSON output parsing
- Works with models available from your configured provider in VS Code

**What Workers Can Do (Autonomously!):**
- **Read files** - Workers can examine any code they need
- **Write files** - Intelligent JSON parsing with automatic escape sequence handling
- **Search codebase** - Find patterns, dependencies, usage examples
- **Multi-step workflows** - Read → Analyze → Create → Verify → Document
- **Error recovery** - Workers see tool results and can retry/fix issues
- **Query LUNA summaries** - Workers can use all LUNA tools for context
- **Parallel task delegation** - Spawn multiple workers for massive speedup

**Key Benefits:**
- **True autonomy** - Workers complete complex tasks without supervision
- **No API key handling in LUNA** - model auth and billing stay with your provider
- **Production-proven** - Tested and working with complex workflows
- **Multi-turn reasoning** - Workers can make 20+ sequential decisions
- **Smart file creation** - JSON blocks with automatic newline/escape handling
- **Automatic** - No setup needed, works out of the box

**How File Creation Works (The Secret Sauce):**
Worker returns this in their response:
```json
{
  "action": "create_file",
  "path": "docs/output.md",
  "content": "# Title\n\nContent here with \\n for newlines"
}
```

LUNA automatically:
1. Detects the JSON block (```json...```)
2. Parses the content field
3. Unescapes `\n`, `\t`, `\r`, `\\` sequences
4. Creates file at the specified path
5. Logs completion with full path

**Result:** File created perfectly formatted

**Example: Autonomous Architecture Documentation**
```javascript
// In Copilot Chat (Agent Mode):
const task = await spawn_worker_agent({
    task_type: 'documentation',
    prompt: `Create architecture summary:
    1. Call mcp_lunaencyclope_get_component_map
    2. Format as markdown
    3. Return JSON block for file creation`,
    model: 'gpt-4o',
    auto_execute: true
});

// Worker autonomously:
// - Calls get_component_map (tool call)
// - Formats data into markdown
// - Returns JSON block with markdown content
// - Extension parses and creates docs/ARCHITECTURE_SUMMARY.md
// 
// Typical completion: 10-30 seconds | Result: Professional documentation
```

## MCP Tools for AI Agents

LUNA provides **18 tools** for Copilot Agent Mode (auto-registered on activation):

**File & Code Tools:**
- `#get_file_summary` - Get cached summary for a specific file (MD + JSON)
- `#search_summaries` - Search across all summaries (keywords, dependencies, components, exports)
- `#list_summaries` - List all cached summaries with metadata
- `#get_dependency_graph` - Get bidirectional dependency relationships (uses/used-by)
- `#analyze_file` - Generate/update summary for specific file using Copilot API

**API Reference Tools:**
- `#get_api_reference` - Get all endpoints with filters (path/method/tag)
- `#search_endpoints` - Search endpoints by path, description, or schema types

**Meta-Analysis Tools:**
- `#get_complexity_heatmap` - Get complexity scores (0-10 scale) and refactoring candidates
- `#get_dead_code` - Get unused exports and dead code analysis with AI validation
- `#get_component_map` - Get architectural component grouping (project boundary detection)
- `#get_qa_report` - Get quality assurance validation results

**Code Review Tools:**
- `#review_file_changes` - Spawn an AI agent to review file changes (git diff) for bugs, logic errors, performance issues, security vulnerabilities, and unintended side effects

**Chat History Tools:**
- `#query_chat_history` - Search past Copilot conversations by keyword, file pattern, or time range
- `#get_chat_activity_digest` - Get a summary digest of all recent chat activity across sessions

**Maintenance Tools:**
- `#list_stale_summaries` - Check which files need re-summarization based on git history

**Worker Agent Tools:**
- `#spawn_worker_agent` - Delegate complex tasks to autonomous background AI workers
- `#check_worker_status` - Poll for worker task completion without blocking
- `#wait_for_workers` - Block until workers finish (with timeout)

**Example Queries:**
```
"Show me the most complex files"
→ #get_complexity_heatmap min_score=7

"What are the unused exports?"
→ #get_dead_code

"What's the architecture?"
→ #get_component_map

"Show me all POST endpoints"
→ #get_api_reference filter_method="POST"

"Show me all API endpoints that return Character objects"
→ #search_endpoints query="Character" search_in="response_schema"

"Which files use the StaticImportAnalyzer?"
→ #search_summaries query="StaticImportAnalyzer" search_type="dependency"

"Review the changes I just made to extension.ts"
→ #review_file_changes file_path="src/extension.ts"

"Check this file for security issues"
→ #review_file_changes file_path="src/auth.ts" review_focus="security"

"What did we discuss about the auth refactor?"
→ #query_chat_history search_text="auth refactor" days_back=30

"Show me a summary of this week's conversations"
→ #get_chat_activity_digest days_back=7
```

## Agent Instructions (Recommended)

To maximize accuracy, teach Copilot to prioritize LUNA summaries. Add this to your system prompt or create a custom agent:

```markdown
# LUNA-First Protocol

When answering questions about code:

1. **ALWAYS check LUNA summaries first** before reading source files
   - Use #search_summaries to find relevant files
   - Use #get_file_summary for detailed analysis
   - Use #get_dependency_graph for relationships
   - Use #get_api_reference for API questions
   - Use #search_endpoints to find specific endpoints
   - **Use #query_chat_history to recall past decisions and discussions** ← NEW!

2. **Only read source code** for:
   - Critical security/business logic verification
   - Implementation details not in summary
   - Debugging specific issues

3. **Self-Maintenance**:
   - If you perform a significant refactor or notice a summary is stale, **suggest that the user run the "LUNA: Summarize File" command** to update the encyclopedia.
   - This keeps the user in the loop and ensures the encyclopedia remains a source of truth.

4. **Benefits**:
   - Instant answers (summaries are cached)
   - Zero token waste (no re-reading files)
   - Focus on higher-level architecture
   - Always up-to-date (summaries track git history)
   - Complete API documentation at your fingertips
   - **Full conversation history searchable by AI agents** (NEW!)

This protocol maximizes efficiency and accuracy.
```

**How to use**:
- Create a file: `.github/copilot-instructions.md` and paste the protocol there (VS Code workspace standard!)
- Or create a custom Copilot agent with these instructions
- Or add to your personal system prompt
- Share with your team for consistent behavior

**Pro tip**: After setup, ask Copilot "Are my summaries up to date?" to see LUNA in action!

## Advanced Features

### Code Breakdowns - Educational Feature
Generate detailed, educational explanations of your code:
```
Right-click file → "LUNA: Explain This Code"
```

**Verbosity Levels:**
- **Beginner**: Full code included, line-by-line explanations, analogies, diagrams, common mistakes
- **Intermediate**: Key snippets, clear explanations, patterns, and gotchas
- **Expert**: Architecture, design decisions, tricky sections only

**Output:** `filename.breakdown.md` - A complete learning document with:
- Table of contents
- Sectioned explanations (imports, classes, functions)
- Code snippets with annotations
- Real-world analogies and examples
- Common mistakes and gotchas

Perfect for onboarding new developers or learning unfamiliar code!

### AI Code Review (NEW - v1.1.25)
Review file changes for bugs, logic errors, performance issues, security vulnerabilities, and unintended side effects. Uses the same model configured in your LUNA settings.

**Two ways to use it:**

**1. User Command (Right-click or Command Palette):**
```
Right-click any file → "LUNA: Review Changes in This File"
- or -
Command Palette (Ctrl+Shift+P) → "LUNA: Review Changes in This File"
```
- Prompts you to select a review focus (All, Bugs, Performance, Security, Style)
- Uses the model from Settings > LUNA model settings
- Shows progress notification with cancel support
- Opens review results in an untitled markdown tab (close it when done, nothing saved to disk)
- No files created and no workspace clutter

**2. MCP Tool (For AI Agents):**
```
"Review the changes I just made to extension.ts"
→ #review_file_changes file_path="src/extension.ts"

"Check this file for security issues only"
→ #review_file_changes file_path="src/auth.ts" review_focus="security"
```
- Agents can pass `old_content` / `new_content` directly for inline diff comparison
- Returns a task ID for async polling via `#check_worker_status` or `#wait_for_workers`

**What happens when you trigger it:**
1. Selects the model from your LUNA settings (same one used for summaries)
2. Reads the current file and computes git diff (unstaged, staged, or HEAD~1)
3. Loads existing LUNA summary for context (purpose, dependencies)
4. Sends everything to the model via the Language Model API
5. Streams the response into an untitled markdown document

**Review Focus Areas:**
- `all` - Comprehensive (default): bugs, performance, security, style, side effects
- `bugs` - Logic errors, null handling, off-by-one, runtime crashes
- `performance` - Inefficient algorithms, memory leaks, unnecessary operations
- `security` - Input validation, injection, authentication gaps
- `style` - Readability, naming, DRY violations, maintainability

**Why this matters for AI-assisted development:**
When AI writes your code, you get a second AI reviewing it with full context: the diff, the file, and LUNA's summary of the file's purpose and dependencies.

### Project Health Report (NEW - v1.1.25)
Get a comprehensive assessment of your entire project's health in one command. Reads all existing LUNA analysis data (complexity heatmap, dead code, component map, dependency graph, QA report) and produces an AI-generated health report.

```
Command Palette (Ctrl+Shift+P) → "LUNA: Project Health Report"
```

**Report includes:**
- **Executive Summary** - 3-4 sentence overview of project health
- **Health Score** - Overall 1-10 rating with justification
- **Critical Issues** - Things that will cause bugs or maintenance nightmares
- **Technical Debt** - Complexity hotspots, dead code, circular dependencies
- **Architecture Assessment** - How well-organized is the code?
- **Prioritized Recommendations** - Numbered list, most important first

**Key details:**
- Uses your configured LUNA model
- Reads all existing `.codebase/` analysis files -- no extra generation needed
- Auto-detects circular dependencies from the dependency graph
- Results open in an untitled tab -- close when done, nothing saved to disk
- Cancellable via the progress notification

### Suggest Refactorings (NEW - v1.1.25)
Get specific, actionable refactoring recommendations for high-complexity files. The AI reads the actual code and provides concrete steps to reduce complexity.

```
Command Palette → "LUNA: Suggest Refactorings"
- or -
Right-click any file → "LUNA: Suggest Refactorings"
```

**Three modes:**
1. **Right-click a file** - Get refactoring suggestions for that specific file
2. **Open a file + Command Palette** - Analyzes the current editor file
3. **Command Palette (no file open)** - Auto-selects the top 5 highest-complexity files (7+/10) from your heatmap and lets you pick which to analyze

**For each file, you get:**
- Current issues and code smells detected
- Prioritized refactoring recommendations (Extract Method, Split Class, etc.)
- Specific functions/lines to change
- Quick wins (< 5 min) vs structural changes (30+ min)
- Estimated complexity score after refactoring

**Key details:**
- Uses your configured LUNA model
- Reads the real source code + LUNA summary for full context
- Focuses on structural improvements, not superficial stuff like variable naming
- Results open in an untitled tab -- close when done

### Chat Session Monitor (NEW - v1.2.0)
Automatically backs up all your Copilot Chat conversations and maintains a searchable activity log. Never lose a conversation again.

**How it works:**
- On extension activation, LUNA finds your workspace's chat session storage automatically (zero config)
- Watches for new messages with a debounced file system watcher
- Incrementally processes only new turns (won't re-process old messages on restart)
- Cross-platform: Windows, macOS, Linux

**What it produces:**
- `.codebase/chat-history/sessions/` — Full markdown backups of every session
  - Human-readable with metadata, timestamps, model info, file references
  - Tool call indicators (🔧) on agent turns
- `.codebase/chat-history/activity-log.jsonl` — Structured log of every turn
  - Queryable by keyword, file pattern, or time range
  - Includes user messages, AI response previews, file references

**Commands:**
```
Command Palette → "LUNA: Backup All Chat Sessions"
→ Forces full backup of all sessions immediately

Command Palette → "LUNA: Chat Activity Digest"
→ Choose time range (24h / 7d / 30d / all time)
→ Opens readable summary of all chat activity
```

**MCP Tools (for AI agent access):**
```
"What did we discuss about authentication last week?"
→ #query_chat_history search_text="authentication" days_back=7

"Show me a summary of all recent conversations"
→ #get_chat_activity_digest days_back=7
```

**Key details:**
- Enabled by default (toggle in Settings > LUNA > Chat Backup Enabled)
- Per-workspace isolation — each workspace has its own chat history
- No named workspace file needed — just opening a folder is enough
- Tracking state persisted to disk — survives VS Code restarts
- Works with every Copilot model and chat mode (agent, edit, chat)

### Quality Assurance Reviews
After fast deterministic analysis, Copilot validates the results:

**Enabled by default** - Configure in Settings → `Enable Copilot QA`

**What gets reviewed:**
- Dead code detection (reduces false positives)
- Complexity scores (validates against actual patterns)
- Component categorization (checks groupings make sense)

**Results saved to:** `.codebase/QA_REPORT.json`

**Benefits:**
- Fewer false positive "dead code" warnings
- Framework-aware (ComfyUI, Django, FastAPI, etc.)
- More accurate refactoring recommendations

### Dead Code Analysis
Find unused exports with AI verification:
```
.codebase/dead-code-analysis.json
```

### Complexity Heatmap  
Refactoring candidates with AI-validated scores (0-10):
```
.codebase/complexity-heatmap.json
```
- 8-10: Needs refactoring
- 6-7: Monitor quality
- 0-5: Good

### Custom Templates (Power User)
Add domain-specific fields to summaries:
```json
{
  "template": {
    "securityConsiderations": "Note security issues",
    "vibeCheck": "3 emojis describing code energy"
  }
}
```
Copy to `.codebase/.luna-template.json` to enable.

## Installation

1. Install from VS Code Marketplace
2. MCP server auto-registers on first activation
3. No manual configuration needed!

## Settings

Configure LUNA in VS Code Settings → Extensions → LUNA Encyclopedia:

**Analysis Settings:**
- **Model Vendor**: Choose provider vendor (default: copilot)
- **Model ID**: Optional exact model ID override
- **Fallback Model Family**: Family used when model ID is empty (default: gpt-4o)
- **Concurrent Workers**: Parallel analysis (1-20, default: 5)
- **Max File Size**: Skip files larger than this (default: 500KB)
- **Enable Copilot QA**: AI reviews deterministic analysis (default: ON)
- **Chat Backup Enabled**: Auto-backup Copilot Chat sessions (default: ON)

**Breakdown Settings:**
- **Breakdown Verbosity**: How detailed code explanations should be
  - Beginner: Full detail with analogies and examples
  - Intermediate: Balanced explanations (default)
  - Expert: Quick architecture overview only

**Advanced:**
- **Branch Aware Summaries**: Separate summaries per git branch
- **File Types**: Which extensions to include/exclude

## Model Availability and Billing

- LUNA lists models exposed by VS Code language model providers at runtime.
- Pricing or premium request details are not exposed through the VS Code LM API.
- Billing is determined by your selected provider and account plan.
- Use `LUNA: Select Summary Model` to choose from currently available models.

---

## Generated Files & Analysis

LUNA generates **structured summaries AND meta-analysis files** in the `.codebase/` folder:

### File Summaries
- **`src/file.md`** - Human-readable summary (purpose, components, dependencies, line numbers)
- **`src/file.json`** - Machine-readable summary (structured for AI agent queries)
- **`src/file.breakdown.md`** - Educational code breakdown (for learning)
- **`src/foldername.index.md`** - Directory index with file listings
- **`src/foldername.index.json`** - Directory index (machine-readable)

### Meta-Analysis Files
- **`complexity-heatmap.json`** - File complexity scores (0-10) with QA validation
- **`component-map.json`** - Smart architectural grouping with QA review
- **`dependency-graph.json`** - Full dependency relationships
- **`dead-code-analysis.json`** - Unused exports with false positive detection
- **`QA_REPORT.json`** - Quality assurance validation results
- **`SUMMARY_REPORT.md`** - Human-readable overview of issues

### Chat History Files
- **`chat-history/sessions/*.md`** - Full markdown backup of each Copilot Chat session
- **`chat-history/activity-log.jsonl`** - Structured log of all chat turns (queryable via MCP)
- **`chat-history/.tracking-state.json`** - Internal state for incremental processing

## Detailed Docs

- **[How to Use LUNA](docs/HOW_TO_ACTUALLY_USE_LUNA.md)** - Practical guide with real examples
- **[Worker Agents](docs/WORKER_AGENTS.md)** - Async task delegation and autonomous agents
- **[True Agent Mode](docs/TRUE_AGENT_MODE.md)** - Using LUNA with Copilot Agent Mode
- **[Architecture](docs/HYBRID_ANALYSIS.md)** - How LUNA works internally
- **[Performance](docs/PERFORMANCE_OPTIMIZATION.md)** - Tips for large codebases
- **[Project Roadmap](docs/Project_roadmap.md)** - Future features and plans

## Architecture Overview

LUNA is built with a **dual-component architecture**:

### VS Code Extension (Core)
**Location:** `src/` (32 TypeScript files)
- **Analyzers**: Codebase analyzer, dependency analyzer, static import analyzer, dead code detector
- **Generators**: API reference generator, bootstrap guide generator, code breakdown generator
- **UI Components**: Summary panel, summary tree provider, summary preview generator
- **Utilities**: Concurrency limiter, staleness detector, git branch detector, ignore pattern matcher
- **Integration**: Extension bridge, git commit watcher, chat session monitor, code navigation handler
- **Entry Point**: [extension.ts](src/extension.ts) - Orchestrates all components

### MCP Server (API Layer)
**Location:** `mcp-server/src/` (5 TypeScript files)
- **Server**: [index.ts](mcp-server/src/index.ts) - MCP server entry point with 18 registered tools
- **Manager**: [summaryManager.ts](mcp-server/src/summaryManager.ts) - Summary CRUD operations
- **Analyzer**: [copilotAnalyzer.ts](mcp-server/src/copilotAnalyzer.ts) - AI-powered file analysis
- **Cache**: [lruCache.ts](mcp-server/src/lruCache.ts) - LRU cache for performance
- **Checker**: [stalenessChecker.ts](mcp-server/src/stalenessChecker.ts) - Git-based staleness detection

### Complexity Metrics
Based on LUNA's own analysis:
- **Highest Complexity:** [codebaseAnalyzer.ts](src/codebaseAnalyzer.ts), [extension.ts](src/extension.ts) (score: 7/10 - CONSIDER_REFACTOR)
- **Most Dependencies:** CodebaseAnalyzer (13 internal imports)
- **Zero Dead Code:** All exports are actively used
- **Well-Modularized:** 29 focused modules with clear responsibilities

## Project Status

LUNA is **production-ready** (v1.2.0) with all major features implemented and tested:

**Core Features:**
- File summarization with precise line numbers and git branch awareness
- Educational code breakdowns (3 verbosity levels: Beginner/Intermediate/Expert)
- AI quality assurance reviews (reduces false positives in analysis)
- Bidirectional dependency tracking (uses + used-by relationships)
- Complexity heatmap for refactoring guidance (0-10 scoring)
- Dead code analysis with AST-based validation
- Smart architecture component mapping with project boundary detection
- Include/exclude pattern system (`.lunasummarize` config)
- Right-click file summarization (context menu integration)
- Universal git commit detection (terminal, GitHub extension, VS Code UI)
- Multi-language support (Python, TypeScript, JavaScript, Java, C#, Go, Rust, C/C++)

**Advanced Analysis (v1.1.23):**
- C# project boundary detection (`.csproj` files)
- API route metadata extraction (separate from inclusion logic)
- Robust YAML parser for `.lunasummarize` configuration
- Dotted namespace pattern recognition (Project.Module boundaries)
- Improved exclude pattern matching (simple dir names work at any depth)

**Worker Agent System (v1.1.21):**
- Fully autonomous worker agents with 15+ MCP tools
- Multi-turn tool-calling conversations (20+ turns)
- File creation via intelligent JSON parsing
- Automatic escape sequence handling (`\n`, `\t`, `\r`, `\\`)
- Parallel task delegation for massive speedup
- Flexible model support via VS Code language model providers
- Production-tested with complex documentation tasks

**Chat Session Monitor (v1.2.0):**
- Automatic backup of all Copilot Chat conversations per workspace
- Incremental processing — only new turns get captured
- Structured activity log (JSONL) queryable via MCP tools
- Full markdown session backups with metadata, timestamps, and file references
- Cross-platform workspace storage detection (Windows, macOS, Linux)
- Tracking state persisted across restarts

**MCP Server Integration:**
- MCP server auto-registers on first activation (stdio transport)
- 18 analysis tools exposed as MCP tools
- Full Copilot Agent Mode integration
- LRU caching for instant queries (zero token cost)
- Extension HTTP bridge for tool access

## Recent Updates (v1.2.0)

**Chat Session Monitor** - Automatically backs up all Copilot Chat conversations to `.codebase/chat-history/`. Full markdown session backups + structured JSONL activity log. Incremental processing (only new turns), cross-platform, per-workspace isolation. Never lose a conversation again.  
**Chat History MCP Tools** - Two new tools: `#query_chat_history` (search past conversations by keyword, file, or time) and `#get_chat_activity_digest` (summary of all recent activity). AI agents can now recall past decisions and context.  
**Backup & Digest Commands** - `LUNA: Backup All Chat Sessions` (force full backup) and `LUNA: Chat Activity Digest` (view activity summary for last 24h/7d/30d/all time).  

**Previously in v1.1.25:**  
**Project Health Report** - `LUNA: Project Health Report` generates a comprehensive project assessment with health score (1-10), critical issues, technical debt, and prioritized recommendations.  
**Suggest Refactorings** - `LUNA: Suggest Refactorings` (command palette + right-click). Auto-selects highest-complexity files. Concrete refactoring plans with specific functions, quick wins vs structural changes.  
**AI Code Review** - `LUNA: Review Changes in This File` + `#review_file_changes` MCP tool. Reviews git diffs for bugs, performance, security, and style.  
**Update Stale now regenerates meta** - Running "Update Stale Summaries" always regenerates meta-analysis (complexity, dead code, dependencies, components) even when no file summaries are stale.  

**Previously in v1.1.23:**
- **Include/Exclude Pattern Fixes** - Fixed critical bugs where `.lunasummarize` exclude patterns were ignored
- **Component Map Intelligence** - Now detects C# project boundaries (`.csproj` files) for accurate architectural grouping
- **API Routes Metadata** - Fixed bug where API route directories were excluded from summaries instead of being flagged for extraction
- **YAML Parser Improvements** - More robust handling of `.lunasummarize` configuration files
- **Better Architecture Detection** - Recognizes dotted namespace patterns and project boundaries automatically

**Previously in v1.1.21:**
- **Worker Agent System - PRODUCTION READY** - Fully autonomous agents with complete tool access
- **Smart File Creation** - JSON-based output with automatic escape sequence handling
- **Multi-turn Tool Loop** - Workers make 20+ sequential decisions and adapt
- **Parallel Task Delegation** - Spawn multiple workers for parallel execution

## License

MIT
