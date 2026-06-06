import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { getConfiguredModelSelection } from './modelSelection';

export interface BackgroundTask {
    id: string;
    taskType: 'documentation' | 'analysis' | 'testing' | 'refactoring' | 'research' | 'other';
    prompt: string;
    contextFiles: string[];
    model: string;
    status: 'queued' | 'running' | 'completed' | 'failed';
    result?: string;
    filesModified?: string[];
    error?: string;
    createdAt: Date;
    startedAt?: Date;
    completedAt?: Date;
    metadata?: Record<string, any>;
    outputFile?: string;
    autoExecute: boolean; // Allow worker to edit/create files
}

export class BackgroundTaskManager {
    private tasks: Map<string, BackgroundTask> = new Map();
    private runningTasks: Set<string> = new Set();
    private outputChannel?: vscode.OutputChannel;

    constructor(outputChannel?: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    private log(message: string): void {
        if (this.outputChannel) {
            this.outputChannel.appendLine(`[BackgroundTaskManager] ${message}`);
        }
        console.log(`[BackgroundTaskManager] ${message}`);
    }

    private getConfig() {
        const config = vscode.workspace.getConfiguration('luna-encyclopedia');
        return {
            concurrencyLimit: config.get<number>('workerConcurrencyLimit', 3),
            defaultWorkerModel: config.get<string>('defaultWorkerModel', 'gpt-4o'),
            workerTimeout: config.get<number>('workerTimeoutSeconds', 300),
            autoCleanupAfter: config.get<number>('workerAutoCleanupHours', 24)
        };
    }

    async submitTask(
        taskType: BackgroundTask['taskType'],
        prompt: string,
        options: {
            contextFiles?: string[];
            model?: string;
            metadata?: Record<string, any>;
            outputFile?: string;
            autoExecute?: boolean;
        } = {}
    ): Promise<string> {
        const config = this.getConfig();
        const taskId = crypto.randomUUID();
        
        const task: BackgroundTask = {
            id: taskId,
            taskType,
            prompt,
            contextFiles: options.contextFiles || [],
            model: options.model || config.defaultWorkerModel,
            status: 'queued',
            createdAt: new Date(),
            metadata: options.metadata,
            outputFile: options.outputFile,
            autoExecute: options.autoExecute ?? true
        };
        
        this.tasks.set(taskId, task);
        this.log(`Task ${taskId} queued: ${taskType} using model ${task.model}`);
        
        // Start processing queue (non-blocking)
        this.processQueue();
        
        return taskId;
    }

    private async processQueue(): Promise<void> {
        const config = this.getConfig();
        
        // Find queued tasks and start them if we have capacity
        while (this.runningTasks.size < config.concurrencyLimit) {
            const nextTask = this.getNextQueuedTask();
            if (!nextTask) {
                break;
            }
            
            this.runningTasks.add(nextTask.id);
            nextTask.status = 'running';
            nextTask.startedAt = new Date();
            
            this.log(`Starting task ${nextTask.id} (${this.runningTasks.size}/${config.concurrencyLimit} slots)`);
            
            // Fire and forget - doesn't block
            this.executeTask(nextTask).finally(() => {
                this.runningTasks.delete(nextTask.id);
                this.log(`Task ${nextTask.id} finished (${this.runningTasks.size}/${config.concurrencyLimit} slots)`);
                this.processQueue(); // Check for more work
            });
        }
    }

    private getNextQueuedTask(): BackgroundTask | undefined {
        for (const task of this.tasks.values()) {
            if (task.status === 'queued') {
                return task;
            }
        }
        return undefined;
    }

    private async executeTask(task: BackgroundTask): Promise<void> {
        const config = this.getConfig();
        const timeout = config.workerTimeout * 1000; // Convert to ms
        
        try {
            // Set up timeout
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error(`Task timed out after ${config.workerTimeout}s`)), timeout);
            });
            
            // Execute with timeout
            await Promise.race([
                this.runWorkerAgent(task),
                timeoutPromise
            ]);
            
            task.status = 'completed';
            task.completedAt = new Date();
            this.log(`Task ${task.id} completed successfully`);
            
        } catch (error) {
            task.status = 'failed';
            task.error = error instanceof Error ? error.message : String(error);
            task.completedAt = new Date();
            this.log(`Task ${task.id} failed: ${task.error}`);
        }
    }

    private async runWorkerAgent(task: BackgroundTask): Promise<void> {
        // Resolve worker model using configured provider first, then fallback selector.
        const configured = getConfiguredModelSelection();
        const selectors: vscode.LanguageModelChatSelector[] = [];

        if (task.model) {
            if (task.model.includes('/')) {
                const [vendor, ...rest] = task.model.split('/');
                const modelId = rest.join('/');
                selectors.push({ vendor, id: modelId });
            } else {
                if (configured.vendor) {
                    selectors.push({ vendor: configured.vendor, id: task.model });
                    selectors.push({ vendor: configured.vendor, family: task.model });
                }
                selectors.push({ id: task.model });
                selectors.push({ family: task.model });
            }
        } else {
            selectors.push(configured.selector);
        }

        let selectedModel: vscode.LanguageModelChat | undefined;
        for (const selector of selectors) {
            const models = await vscode.lm.selectChatModels(selector);
            if (models.length > 0) {
                selectedModel = models[0];
                break;
            }
        }

        if (!selectedModel) {
            const requested = task.model || configured.label;
            throw new Error(`Worker model "${requested}" is not available. Use "LUNA: Select Summary Model" or update LUNA model settings.`);
        }
        
        // Always try to use tool-calling mode first (models support it automatically)
        this.log(`Worker ${task.id}: Using agent mode with tool access`);
        await this.runWorkerWithTools(task, selectedModel);
    }

    private async runWorkerWithTools(task: BackgroundTask, model: vscode.LanguageModelChat): Promise<void> {
        // Build context from files
        let fileContext = '';
        if (task.contextFiles.length > 0) {
            fileContext = '\n\n## Context Files:\n\n';
            
            for (const filePath of task.contextFiles) {
                try {
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    if (!workspaceFolder) {
                        throw new Error('No workspace folder open');
                    }
                    
                    const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
                    const fileContent = await vscode.workspace.fs.readFile(fullPath);
                    const content = Buffer.from(fileContent).toString('utf8');
                    
                    fileContext += `### ${filePath}\n\`\`\`\n${content}\n\`\`\`\n\n`;
                } catch (error) {
                    this.log(`Warning: Could not read context file ${filePath}: ${error}`);
                }
            }
        }

        // Build system prompt for tool-enabled agent
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : '';
        
        const systemPrompt = `You are an AI worker agent with full tool access. Execute the delegated task autonomously.

Task Type: ${task.taskType}
${task.outputFile ? `Target Output File: ${task.outputFile}` : ''}
Workspace Root: ${workspaceRoot}

${fileContext}

## Available Tools:

**File Operations (from edit/read/search toolsets):**
- createFile - Create a new file (provide filePath and content)
- readFile - Read a file's contents (provide filePath)
- editFiles - Edit existing files
- createDirectory - Create a directory (provide dirPath)
- fileSearch - Find files by pattern
- textSearch - Search for text across files
- listDirectory - List directory contents

**LUNA Encyclopedia Tools (workspace_path is AUTO-INJECTED!):**
- mcp_lunaencyclope_get_file_summary - Get cached file analysis (only needs: file_path)
- mcp_lunaencyclope_search_summaries - Search summaries (needs: query, search_type)
- mcp_lunaencyclope_get_dependency_graph - Get file relationships (optional: file_path)
- mcp_lunaencyclope_get_component_map - Get architecture (no params needed)
- mcp_lunaencyclope_get_complexity_heatmap - Get refactoring candidates (optional: min_score)
- mcp_lunaencyclope_get_dead_code - Get unused exports (no params needed)
- mcp_lunaencyclope_get_api_reference - Get API endpoints (optional filters)

**CRITICAL INSTRUCTIONS:**
1. **copilot_createFile doesn't work for workers** - Instead, return file content in JSON format
2. **JSON format**: In your final message, include a code block with json language tag containing:
   - "action": "create_file"
   - "path": "relative/path/to/file.md"  
   - "content": "your file content here"
3. **For LUNA tools**: DON'T provide workspace_path - it's automatically injected!
4. **Multiple files**: Include multiple JSON blocks in your final message

**Example Final Message:**
I gathered the architecture data. Here's the file to create:

\`\`\`json
{
  "action": "create_file",
  "path": "docs/architecture.md",
  "content": "# Architecture\\n\\nYour content here..."
}
\`\`\`

Use tools to gather data, then return JSON blocks for files to create.`;

        const fullPrompt = `${systemPrompt}\n\n## Task Instructions:\n${task.prompt}`;

        // Start conversation with tool-calling loop
        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(fullPrompt)
        ];

        const cancellationToken = new vscode.CancellationTokenSource().token;
        const maxTurns = 20; // Prevent infinite loops
        let turnCount = 0;
        let finalResult = '';
        const filesModified: string[] = [];

        // Multi-turn conversation loop for tool calling
        while (turnCount < maxTurns) {
            turnCount++;
            this.log(`Worker ${task.id}: Turn ${turnCount}`);

            // Get available tools from VS Code and filter to worker-relevant subset
            // Workers have a 128 tool limit, so we curate the most useful ones
            const allTools = vscode.lm.tools;
            const workerTools = this.filterToolsForWorkers(allTools);

            // Send request with curated tools
            const response = await model.sendRequest(messages, {
                tools: workerTools,
                toolMode: vscode.LanguageModelChatToolMode.Auto
            }, cancellationToken);

            let responseText = '';
            const toolCalls: vscode.LanguageModelToolCallPart[] = [];

            // Process response stream
            for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    responseText += part.value;
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCalls.push(part);
                }
            }

            // If no tool calls, we're done
            if (toolCalls.length === 0) {
                finalResult = responseText;
                this.log(`Worker ${task.id}: Completed in ${turnCount} turns`);
                break;
            }

            // Add assistant message with tool calls
            messages.push(vscode.LanguageModelChatMessage.Assistant([
                ...toolCalls,
                ...(responseText ? [new vscode.LanguageModelTextPart(responseText)] : [])
            ]));

            // Execute each tool call
            const toolResults: vscode.LanguageModelToolResultPart[] = [];
            
            for (const toolCall of toolCalls) {
                try {
                    this.log(`Worker ${task.id}: Calling tool ${toolCall.name} with input: ${JSON.stringify(toolCall.input).substring(0, 200)}...`);
                    
                    // Inject workspace_path for LUNA tools automatically
                    const enhancedInput = this.injectWorkspacePathForLunaTool(toolCall.name, toolCall.input);
                    
                    const toolResult = await vscode.lm.invokeTool(
                        toolCall.name,
                        { 
                            input: enhancedInput,
                            toolInvocationToken: undefined // Workers run outside chat participant context
                        },
                        cancellationToken
                    );

                    // Log result summary
                    const resultPreview = JSON.stringify(toolResult.content).substring(0, 300);
                    this.log(`Worker ${task.id}: Tool ${toolCall.name} returned: ${resultPreview}...`);

                    // Track file modifications
                    if (toolCall.name.includes('write') || toolCall.name.includes('create')) {
                        const filePath = this.extractFilePathFromToolCall(toolCall);
                        if (filePath && !filesModified.includes(filePath)) {
                            filesModified.push(filePath);
                        }
                    }

                    toolResults.push(new vscode.LanguageModelToolResultPart(toolCall.callId, toolResult.content));
                } catch (error) {
                    this.log(`Worker ${task.id}: Tool call failed: ${error}`);
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    toolResults.push(new vscode.LanguageModelToolResultPart(
                        toolCall.callId,
                        [new vscode.LanguageModelTextPart(`Error: ${errorMessage}`)]
                    ));
                }
            }

            // Add user message with tool results
            messages.push(vscode.LanguageModelChatMessage.User(toolResults));
        }

        if (turnCount >= maxTurns) {
            throw new Error('Worker exceeded maximum turn limit (20)');
        }

        task.result = finalResult;
        
        // Parse final result for file creation JSON blocks
        if (task.autoExecute && finalResult) {
            await this.parseAndCreateFilesFromWorkerOutput(task, finalResult, filesModified);
        }
        
        task.filesModified = filesModified;
    }

    private async parseAndCreateFilesFromWorkerOutput(task: BackgroundTask, output: string, filesModified: string[]): Promise<void> {
        // Look for JSON blocks with file creation instructions
        const jsonBlockRegex = /```json\s*\n([\s\S]*?)\n```/g;
        let match;
        
        while ((match = jsonBlockRegex.exec(output)) !== null) {
            try {
                const jsonContent = match[1];
                const fileSpec = JSON.parse(jsonContent);
                
                if (fileSpec.action === 'create_file' && fileSpec.path && fileSpec.content) {
                    await this.createFileFromWorker(fileSpec.path, fileSpec.content, filesModified);
                }
            } catch (error) {
                this.log(`Failed to parse JSON block: ${error}`);
            }
        }
    }

    private async createFileFromWorker(relativePath: string, content: string, filesModified: string[]): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder available');
        }

        const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);
        
        // Create parent directories if needed
        const dirPath = vscode.Uri.joinPath(fullPath, '..');
        try {
            await vscode.workspace.fs.createDirectory(dirPath);
        } catch {
            // Directory might already exist
        }

        // Unescape the content (convert \\n to actual newlines, \\t to tabs, etc.)
        const unescapedContent = content
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\r/g, '\r')
            .replace(/\\\\/g, '\\');

        // Write the file
        await vscode.workspace.fs.writeFile(fullPath, Buffer.from(unescapedContent, 'utf-8'));
        filesModified.push(fullPath.fsPath);
        this.log(`Worker created file: ${relativePath}`);
    }


    private async runWorkerWithJsonOutput(task: BackgroundTask, model: vscode.LanguageModelChat): Promise<void> {
        // Fallback to old JSON output mode for models without tool support
        
        // Build context from files
        let fileContext = '';
        if (task.contextFiles.length > 0) {
            fileContext = '\n\n## Context Files:\n\n';
            
            for (const filePath of task.contextFiles) {
                try {
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    if (!workspaceFolder) {
                        throw new Error('No workspace folder open');
                    }
                    
                    const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
                    const fileContent = await vscode.workspace.fs.readFile(fullPath);
                    const content = Buffer.from(fileContent).toString('utf8');
                    
                    fileContext += `### ${filePath}\n\`\`\`\n${content}\n\`\`\`\n\n`;
                } catch (error) {
                    this.log(`Warning: Could not read context file ${filePath}: ${error}`);
                }
            }
        }

        // Build the worker prompt with structured output requirements
        const systemPrompt = `You are an AI worker agent executing a delegated task.

Task Type: ${task.taskType}
Auto-Execute: ${task.autoExecute ? 'YES - Your output will be automatically saved to files' : 'NO - Return suggestions only'}
${task.outputFile ? `Output File: ${task.outputFile}` : ''}

${fileContext}

## CRITICAL: Output Format
You MUST return your response with valid JSON. Use \\n for newlines, escape quotes as \\", and escape backslashes as \\\\.

Example:
\`\`\`json
{
  "summary": "Brief description of what you did",
  "files": [
    {
      "path": "docs/example.md",
      "content": "# Title\\n\\nThis is content with \\"quotes\\" and newlines."
    }
  ]
}
\`\`\`

If creating multiple files, add more objects to the "files" array.
Always include "summary" describing what you accomplished.`;

        const fullPrompt = `${systemPrompt}\n\n## Task Instructions:\n${task.prompt}`;

        // Send request to model
        const messages = [vscode.LanguageModelChatMessage.User(fullPrompt)];
        const cancellationToken = new vscode.CancellationTokenSource().token;
        
        const response = await model.sendRequest(messages, {}, cancellationToken);
        
        // Collect response
        let result = '';
        for await (const fragment of response.text) {
            result += fragment;
        }
        
        task.result = result;
        
        // If autoExecute is enabled, parse response and create files
        if (task.autoExecute) {
            await this.executeWorkerOutput(task, result);
        }
    }

    private extractFilePathFromToolCall(toolCall: vscode.LanguageModelToolCallPart): string | null {
        try {
            const input = toolCall.input as any;
            // Try common parameter names for file paths
            return input?.path || input?.filePath || input?.uri || input?.file || null;
        } catch {
            return null;
        }
    }

    private injectWorkspacePathForLunaTool(toolName: string, input: object): object {
        // Check if this is a LUNA MCP tool
        if (!toolName.startsWith('mcp_lunaencyclope_')) {
            return input; // Not a LUNA tool, return as-is
        }

        const inputObj = input as any;
        
        // If workspace_path is already a valid path (not placeholder), don't override it
        // Skip injection only if it looks like a real path (absolute or relative with slashes)
        const hasRealPath = inputObj.workspace_path && 
                           typeof inputObj.workspace_path === 'string' &&
                           (inputObj.workspace_path.includes('/') || inputObj.workspace_path.includes('\\'));
        
        if (hasRealPath) {
            return input;
        }

        // Inject workspace_path from current workspace
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            this.log('Warning: No workspace folder available to inject for LUNA tool');
            return input;
        }

        const injected = {
            ...inputObj,
            workspace_path: workspaceFolder.uri.fsPath
        };
        
        this.log(`Injected workspace_path for ${toolName}: ${workspaceFolder.uri.fsPath}`);
        return injected;
    }

    private filterToolsForWorkers(allTools: readonly vscode.LanguageModelChatTool[]): vscode.LanguageModelChatTool[] {
        // Workers have a 128 tool limit, so filter to the most useful subset
        const allowedToolPatterns = [
            // VS Code built-in tools (actual API names have copilot_ prefix)
            /^copilot_readFile$/i,
            /^copilot_createFile$/i,
            /^copilot_createDirectory$/i,
            /^copilot_listDirectory$/i,
            /^copilot_findFiles$/i,
            /^copilot_findTextInFiles$/i,
            /^copilot_editFiles$/i,
            
            // LUNA tools (confirmed working with mcp_lunaencyclope_ prefix)
            /^mcp_lunaencyclope_get_file_summary$/i,
            /^mcp_lunaencyclope_search_summaries$/i,
            /^mcp_lunaencyclope_list_summaries$/i,
            /^mcp_lunaencyclope_get_dependency_graph$/i,
            /^mcp_lunaencyclope_analyze_file$/i,
            /^mcp_lunaencyclope_list_stale_summaries$/i,
            /^mcp_lunaencyclope_get_api_reference$/i,
            /^mcp_lunaencyclope_search_endpoints$/i,
            /^mcp_lunaencyclope_get_complexity_heatmap$/i,
            /^mcp_lunaencyclope_get_dead_code$/i,
            /^mcp_lunaencyclope_get_component_map$/i,
            /^mcp_lunaencyclope_get_qa_report$/i,
            
            // Limited GitHub tools (only the useful ones)
            /^mcp_github_list_branches$/i,
            /^mcp_github_list_commits$/i,
            /^mcp_github_get_commit$/i,
            /^mcp_github_get_file_contents$/i,
            
            // Pylance tools for Python development
            /^mcp_pylance/i
        ];

        // Exclude patterns for tools workers should NOT have
        const excludeToolPatterns = [
            // No worker spawning (prevent recursion)
            /spawn.*worker/i,
            /check.*worker.*status/i,
            /wait.*for.*workers/i,
            
            // No web/fetch tools
            /web.*search/i,
            /fetch.*webpage/i,
            /github.*search.*repo/i,
            
            // No PostgreSQL tools
            /pgsql/i,
            /postgres/i,
            
            // No container tools
            /container/i,
            /docker/i,
            
            // No agent/subagent tools
            /agent/i,
            /subagent/i
        ];

        const filtered = Array.from(allTools).filter(tool => {
            const toolName = tool.name;
            
            // Check exclude patterns first
            if (excludeToolPatterns.some(pattern => pattern.test(toolName))) {
                return false;
            }
            
            // Then check if it matches allowed patterns
            return allowedToolPatterns.some(pattern => pattern.test(toolName));
        });

        // Log which tools are available for debugging
        this.log(`Filtered tools for workers: ${filtered.length} tools available (from ${allTools.length} total)`);
        this.log(`Tool names: ${filtered.map(t => t.name).join(', ')}`);
        
        // If we still have too many tools, log a warning
        if (filtered.length > 128) {
            this.log(`WARNING: Worker tools (${filtered.length}) exceed 128 limit. Some tools may not be available.`);
            return filtered.slice(0, 128); // Take first 128
        }
        
        return filtered;
    }

    private async executeWorkerOutput(task: BackgroundTask, result: string): Promise<void> {
        try {
            // Extract JSON from response (handle markdown code blocks)
            const jsonMatch = result.match(/```json\s*([\s\S]*?)\s*```/);
            if (!jsonMatch) {
                this.log(`Worker ${task.id}: No structured output found, skipping file operations`);
                return;
            }

            let output;
            try {
                output = JSON.parse(jsonMatch[1]);
            } catch (parseError) {
                // JSON parsing failed - likely due to unescaped characters in content
                // Try to extract using a more lenient approach
                this.log(`Worker ${task.id}: JSON parse failed, attempting lenient extraction`);
                
                // Try to extract the structure manually
                const summaryMatch = jsonMatch[1].match(/"summary"\s*:\s*"([^"]*?)"/);
                const pathMatch = jsonMatch[1].match(/"path"\s*:\s*"([^"]*?)"/);
                
                // Find content - it's everything between "content": " and the next "}
                const contentStart = jsonMatch[1].indexOf('"content"');
                if (contentStart === -1 || !pathMatch) {
                    throw new Error(`Could not extract file content from malformed JSON: ${parseError}`);
                }
                
                // Extract content more carefully
                const afterContent = jsonMatch[1].substring(contentStart);
                const contentMatch = afterContent.match(/"content"\s*:\s*"([\s\S]*?)"\s*\}/);
                
                if (!contentMatch) {
                    throw new Error(`Could not extract content field: ${parseError}`);
                }
                
                // Unescape the content
                const unescapedContent = contentMatch[1]
                    .replace(/\\n/g, '\n')
                    .replace(/\\t/g, '\t')
                    .replace(/\\"/g, '"')
                    .replace(/\\\\/g, '\\');
                
                output = {
                    summary: summaryMatch ? summaryMatch[1] : 'Worker completed',
                    files: [{
                        path: pathMatch[1],
                        content: unescapedContent
                    }]
                };
            }
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new Error('No workspace folder open');
            }

            // Execute file operations
            const filesModified: string[] = [];
            
            if (output.files && Array.isArray(output.files)) {
                for (const file of output.files) {
                    if (!file.path || !file.content) {
                        continue;
                    }

                    const filePath = vscode.Uri.joinPath(workspaceFolder.uri, file.path);
                    const content = new TextEncoder().encode(file.content);
                    
                    // Create directory if needed
                    const dirPath = vscode.Uri.joinPath(filePath, '..');
                    try {
                        await vscode.workspace.fs.createDirectory(dirPath);
                    } catch (error) {
                        // Directory might already exist
                    }

                    // Write file
                    await vscode.workspace.fs.writeFile(filePath, content);
                    filesModified.push(file.path);
                    this.log(`Worker ${task.id}: Created/updated ${file.path}`);
                }
            }

            task.filesModified = filesModified;

            // Update result with execution confirmation
            task.result = `${output.summary}\n\nFiles modified: ${filesModified.join(', ') || 'none'}${output.analysis ? `\n\nAnalysis:\n${output.analysis}` : ''}`;
            
        } catch (error) {
            this.log(`Worker ${task.id}: Failed to execute file operations: ${error}`);
            // Don't fail the task, just log the error
        }
    }

    getTaskStatus(taskId: string): BackgroundTask | undefined {
        return this.tasks.get(taskId);
    }

    getAllTasks(statusFilter?: BackgroundTask['status']): BackgroundTask[] {
        const tasks = Array.from(this.tasks.values());
        
        if (!statusFilter) {
            return tasks;
        }
        
        return tasks.filter(t => t.status === statusFilter);
    }

    async waitForTasks(taskIds?: string[], timeoutSeconds: number = 60): Promise<BackgroundTask[]> {
        const tasksToWait = taskIds 
            ? taskIds.map(id => this.tasks.get(id)).filter(t => t !== undefined) as BackgroundTask[]
            : this.getAllTasks().filter(t => t.status === 'running' || t.status === 'queued');
        
        const startTime = Date.now();
        const timeoutMs = timeoutSeconds * 1000;
        
        while (Date.now() - startTime < timeoutMs) {
            const allDone = tasksToWait.every(t => 
                t.status === 'completed' || t.status === 'failed'
            );
            
            if (allDone) {
                return tasksToWait;
            }
            
            // Wait 100ms before checking again
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Timeout reached - return current state
        return tasksToWait;
    }

    cancelTask(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (task && task.status === 'queued') {
            task.status = 'failed';
            task.error = 'Cancelled by user';
            task.completedAt = new Date();
            this.log(`Task ${taskId} cancelled`);
            return true;
        }
        return false;
    }

    clearCompletedTasks(): number {
        let cleared = 0;
        for (const [id, task] of this.tasks.entries()) {
            if (task.status === 'completed' || task.status === 'failed') {
                this.tasks.delete(id);
                cleared++;
            }
        }
        this.log(`Cleared ${cleared} completed/failed tasks`);
        return cleared;
    }

    autoCleanup(): void {
        const config = this.getConfig();
        const cutoffTime = new Date(Date.now() - config.autoCleanupAfter * 60 * 60 * 1000);
        
        let cleaned = 0;
        for (const [id, task] of this.tasks.entries()) {
            if ((task.status === 'completed' || task.status === 'failed') && 
                task.completedAt && task.completedAt < cutoffTime) {
                this.tasks.delete(id);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            this.log(`Auto-cleanup removed ${cleaned} old tasks`);
        }
    }

    getStats(): {
        total: number;
        queued: number;
        running: number;
        completed: number;
        failed: number;
    } {
        const tasks = this.getAllTasks();
        return {
            total: tasks.length,
            queued: tasks.filter(t => t.status === 'queued').length,
            running: tasks.filter(t => t.status === 'running').length,
            completed: tasks.filter(t => t.status === 'completed').length,
            failed: tasks.filter(t => t.status === 'failed').length
        };
    }
}
