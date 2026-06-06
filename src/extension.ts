import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SummaryTreeProvider } from './summaryTreeProvider';
import { SummaryPanel } from './summaryPanel';
import { CodebaseAnalyzer } from './codebaseAnalyzer';
import { CodeNavigationHandler } from './codeNavigationHandler';
import { SummaryPreviewGenerator } from './summaryPreviewGenerator';
import { CodeBreakdownGenerator } from './codeBreakdownGenerator';
import { GitCommitWatcher } from './gitCommitWatcher';
import { PromptManager } from './promptManager';
import { BackgroundTaskManager } from './backgroundTaskManager';
import { ExtensionBridge } from './extensionBridge';
import { ChatSessionMonitor } from './chatSessionMonitor';
import {
    formatLanguageModel,
    getConfiguredModelSelection,
    listAvailableChatModels,
    requireConfiguredChatModel,
    saveSelectedChatModel
} from './modelSelection';

let summaryTreeProvider: SummaryTreeProvider;
let gitCommitWatcher: GitCommitWatcher | null = null;
let chatSessionMonitor: ChatSessionMonitor | null = null;
let lunaOutputChannel: vscode.OutputChannel;
let taskManager: BackgroundTaskManager;
let extensionBridge: ExtensionBridge;

export async function activate(context: vscode.ExtensionContext) {
    console.log('LUNA Codebase Encyclopedia is now active');

    // Create output channel for LUNA logs
    lunaOutputChannel = vscode.window.createOutputChannel('LUNA');
    lunaOutputChannel.appendLine('🌙 LUNA Codebase Encyclopedia activated');

    // Initialize prompt manager
    PromptManager.initialize(context.extensionUri);

    // ALWAYS re-register MCP server on every activation
    // This ensures the bundled MCP server is always used, regardless of install/update/reinstall
    lunaOutputChannel.appendLine('📡 Registering MCP server...');
    await registerMCPServer(context);

    // Initialize providers
    summaryTreeProvider = new SummaryTreeProvider(context);
    const codebaseAnalyzer = new CodebaseAnalyzer(context, lunaOutputChannel);
    taskManager = new BackgroundTaskManager(lunaOutputChannel);

    // Start extension HTTP bridge for MCP server communication
    extensionBridge = new ExtensionBridge(taskManager);
    try {
        const port = await extensionBridge.start();
        lunaOutputChannel.appendLine(`🌉 Extension bridge started on port ${port}`);
        
        // Save port to file for MCP server to discover
        const bridgePortFile = path.join(os.homedir(), '.luna-bridge-port');
        fs.writeFileSync(bridgePortFile, port.toString(), 'utf8');
        lunaOutputChannel.appendLine(`📝 Bridge port saved to ${bridgePortFile}`);
    } catch (error) {
        lunaOutputChannel.appendLine(`⚠️ Failed to start extension bridge: ${error}`);
        vscode.window.showWarningMessage('LUNA worker agents unavailable: bridge failed to start');
    }

    // Start auto-cleanup timer for old tasks (runs every hour)
    const cleanupInterval = setInterval(() => {
        taskManager.autoCleanup();
    }, 60 * 60 * 1000); // 1 hour
    context.subscriptions.push({ dispose: () => clearInterval(cleanupInterval) });

    // Register URI handler for code navigation
    const uriHandler = CodeNavigationHandler.register(context);

    // Start git commit watcher (works with terminal, GitHub extension, etc.)
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
        gitCommitWatcher = new GitCommitWatcher(workspaceFolder.uri.fsPath);
        gitCommitWatcher.start();
    }

    // Start chat session monitor (backs up Copilot conversations)
    chatSessionMonitor = new ChatSessionMonitor(context, lunaOutputChannel);
    chatSessionMonitor.start().catch(err => {
        lunaOutputChannel.appendLine(`⚠️ Chat monitor failed to start: ${err}`);
    });

    // Register tree view
    const treeView = vscode.window.registerTreeDataProvider('luna-encyclopedia.summaryTree', summaryTreeProvider);

    // Register commands
    const initCommand = vscode.commands.registerCommand('luna-encyclopedia.initialize', async () => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Initializing LUNA...",
            cancellable: false
        }, async (progress, token) => {
            try {
                await codebaseAnalyzer.initializeWorkspace(progress, token);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to initialize LUNA: ${error}`);
            }
        });
    });

    const generateCommand = vscode.commands.registerCommand('luna-encyclopedia.generateSummaries', async () => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Generating codebase summaries...",
            cancellable: true
        }, async (progress, token) => {
            try {
                await codebaseAnalyzer.generateSummaries(progress, token);
                summaryTreeProvider.refresh();
                vscode.window.showInformationMessage('✅ Summaries generated successfully!');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to generate summaries: ${error}`);
            }
        });
    });

    const updateStaleCommand = vscode.commands.registerCommand('luna-encyclopedia.updateStale', async () => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Updating stale summaries...",
            cancellable: true
        }, async (progress, token) => {
            try {
                await codebaseAnalyzer.updateStaleSummaries(progress, token);
                summaryTreeProvider.refresh();
                vscode.window.showInformationMessage('✅ Stale summaries updated!');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to update summaries: ${error}`);
            }
        });
    });

    const showSummaryCommand = vscode.commands.registerCommand('luna-encyclopedia.showSummary', (summaryPath?: string) => {
        SummaryPanel.createOrShow(context.extensionUri, summaryPath);
    });

    const refreshCommand = vscode.commands.registerCommand('luna-encyclopedia.refreshTree', () => {
        summaryTreeProvider.refresh();
    });

    const summarizeFileCommand = vscode.commands.registerCommand('luna-encyclopedia.summarizeFile', async (fileUri?: vscode.Uri) => {
        // Get the file URI from context menu or active editor
        const targetUri = fileUri || vscode.window.activeTextEditor?.document.uri;
        
        if (!targetUri) {
            vscode.window.showErrorMessage('No file selected. Please right-click a file or open one in the editor.');
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri);
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('File is not in the current workspace.');
            return;
        }

        // Get relative path from workspace root
        const relativePath = path.relative(workspaceFolder.uri.fsPath, targetUri.fsPath);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Summarizing ${path.basename(targetUri.fsPath)}...`,
            cancellable: true
        }, async (progress, token) => {
            try {
                await codebaseAnalyzer.summarizeSingleFile(relativePath, workspaceFolder.uri.fsPath, progress, token);
                summaryTreeProvider.refresh();
                vscode.window.showInformationMessage(`✅ Summary generated for ${path.basename(targetUri.fsPath)}`);
                
                // Show the summary in the summary panel
                const summaryPath = path.join(workspaceFolder.uri.fsPath, '.codebase', relativePath.replace(/\.[^.]+$/, '.md'));
                SummaryPanel.createOrShow(context.extensionUri, summaryPath);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to summarize file: ${error}`);
            }
        });
    });

    const previewFilesCommand = vscode.commands.registerCommand('luna-encyclopedia.previewFiles', async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }

        try {
            const generator = new SummaryPreviewGenerator(workspaceFolder.uri.fsPath);
            const previewPath = path.join(workspaceFolder.uri.fsPath, '.codebase', 'preview-included-files.txt');
            
            await generator.savePreview(previewPath);
            
            // Open the preview file
            const doc = await vscode.workspace.openTextDocument(previewPath);
            await vscode.window.showTextDocument(doc);
            
            vscode.window.showInformationMessage('✅ Preview generated! Check preview-included-files.txt');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to generate preview: ${error}`);
        }
    });

    const selectSummaryModelCommand = vscode.commands.registerCommand('luna-encyclopedia.selectSummaryModel', async () => {
        try {
            const models = await listAvailableChatModels();
            if (models.length === 0) {
                vscode.window.showWarningMessage('No VS Code chat models are currently available. Install or sign into a language model provider first.');
                return;
            }

            const currentSelection = getConfiguredModelSelection();
            const picked = await vscode.window.showQuickPick(
                models.map(model => ({
                    label: model.name,
                    description: `${model.vendor} | family: ${model.family}`,
                    detail: `id: ${model.id}${currentSelection.id === model.id ? ' | currently selected' : ''}`,
                    model
                })),
                {
                    title: 'LUNA: Select Summary Model',
                    placeHolder: 'Choose the live chat model LUNA should use for summaries and analysis',
                    matchOnDescription: true,
                    matchOnDetail: true
                }
            );

            if (!picked) {
                return;
            }

            await saveSelectedChatModel(picked.model);
            vscode.window.showInformationMessage(`LUNA will use ${formatLanguageModel(picked.model)}.`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to select model: ${error}`);
        }
    });

    const showAvailableModelsCommand = vscode.commands.registerCommand('luna-encyclopedia.showAvailableModels', async () => {
        try {
            const models = await listAvailableChatModels();
            if (models.length === 0) {
                vscode.window.showWarningMessage('No VS Code chat models are currently available.');
                return;
            }

            const configured = getConfiguredModelSelection();
            const lines = [
                '# Available Chat Models',
                '',
                `Configured selector: ${configured.label}`,
                'Pricing details are not exposed by the VS Code LM API.',
                '',
                '| Name | Vendor | Family | ID | Version |',
                '| --- | --- | --- | --- | --- |',
                ...models.map(model => `| ${model.name} | ${model.vendor} | ${model.family} | ${model.id} | ${model.version || ''} |`)
            ];

            const doc = await vscode.workspace.openTextDocument({
                content: lines.join('\n'),
                language: 'markdown'
            });
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to list available models: ${error}`);
        }
    });

    const reregisterMCPCommand = vscode.commands.registerCommand('luna-encyclopedia.reregisterMCP', async () => {
        try {
            await registerMCPServer(context, true); // Force restart
            vscode.window.showInformationMessage('✅ LUNA MCP Server restarted with latest code!');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to re-register MCP server: ${error}`);
        }
    });

    // Generate detailed code breakdown
    const generateBreakdownCommand = vscode.commands.registerCommand('luna-encyclopedia.generateBreakdown', async (fileUri?: vscode.Uri) => {
        // Get file from context menu or active editor
        let targetUri = fileUri;
        if (!targetUri) {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                targetUri = activeEditor.document.uri;
            }
        }

        if (!targetUri) {
            vscode.window.showErrorMessage('No file selected. Right-click a file or open one in the editor.');
            return;
        }

        const filePath = targetUri.fsPath;
        const fileName = path.basename(filePath);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Generating code breakdown for ${fileName}...`,
            cancellable: true
        }, async (progress, token) => {
            try {
                const breakdownGenerator = new CodeBreakdownGenerator(context);
                
                progress.report({ message: '🚀 Starting breakdown generation...' });
                
                const breakdown = await breakdownGenerator.generateBreakdown(filePath, progress, token);
                const savedPath = await breakdownGenerator.saveBreakdown(filePath, breakdown);
                
                // Open the breakdown file
                const doc = await vscode.workspace.openTextDocument(savedPath);
                await vscode.window.showTextDocument(doc, { preview: false });
                
                const verbosity = vscode.workspace.getConfiguration('luna-encyclopedia').get<string>('breakdownVerbosity', 'intermediate');
                vscode.window.showInformationMessage(`✅ Code breakdown generated (${verbosity} mode)! See ${path.basename(savedPath)}`);
            } catch (error) {
                if (token.isCancellationRequested) {
                    vscode.window.showInformationMessage('Breakdown generation cancelled.');
                } else {
                    vscode.window.showErrorMessage(`Failed to generate breakdown: ${error}`);
                }
            }
        });
    });

    // Watch for file changes to refresh the tree
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidChange(() => summaryTreeProvider.refresh());
    watcher.onDidCreate(() => summaryTreeProvider.refresh());
    watcher.onDidDelete(() => summaryTreeProvider.refresh());

    // Reset .codebase directory command
    const resetCommand = vscode.commands.registerCommand('luna-encyclopedia.reset', async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        const codebasePath = path.join(workspaceFolder.uri.fsPath, '.codebase');
        const fs = require('fs');

        // Check if .codebase exists
        if (!fs.existsSync(codebasePath)) {
            vscode.window.showWarningMessage('No .codebase directory found to reset');
            return;
        }

        // Confirm deletion
        const confirm = await vscode.window.showWarningMessage(
            '⚠️ This will permanently delete all summaries, analysis data, and configuration in .codebase/. Continue?',
            { modal: true },
            'Yes, Reset',
            'Cancel'
        );

        if (confirm !== 'Yes, Reset') {
            return;
        }

        try {
            // Delete the directory recursively
            fs.rmSync(codebasePath, { recursive: true, force: true });
            
            // Refresh tree view
            summaryTreeProvider.refresh();

            const action = await vscode.window.showInformationMessage(
                '✅ .codebase directory reset successfully!',
                'Initialize Now',
                'Done'
            );

            if (action === 'Initialize Now') {
                vscode.commands.executeCommand('luna-encyclopedia.initialize');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to reset .codebase: ${error}`);
        }
    });

    // Regenerate meta-summaries only (complexity, dead-code, component-map, dependency-graph, QA)
    const regenerateMetaCommand = vscode.commands.registerCommand('luna-encyclopedia.regenerateMeta', async () => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Regenerating meta-analysis summaries...",
            cancellable: true
        }, async (progress, token) => {
            try {
                await codebaseAnalyzer.regenerateMetaSummaries(progress, token);
                summaryTreeProvider.refresh();
                vscode.window.showInformationMessage('✅ Meta-summaries regenerated successfully!');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to regenerate meta-summaries: ${error}`);
            }
        });
    });

    // Review file changes command - opens Copilot Chat with review context
    const reviewFileChangesCommand = vscode.commands.registerCommand('luna-encyclopedia.reviewFileChanges', async (fileUri?: vscode.Uri) => {
        // Get file from context menu, active editor, or diff editor
        let targetUri = fileUri;
        if (!targetUri) {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                targetUri = activeEditor.document.uri;
            }
        }

        if (!targetUri) {
            vscode.window.showErrorMessage('No file selected. Right-click a file or open one in the editor.');
            return;
        }

        // Handle diff editor URIs - extract the actual file path
        let filePath = targetUri.fsPath;
        if (targetUri.scheme === 'git') {
            filePath = targetUri.path;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }

        const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);
        const fileName = path.basename(filePath);

        // Ask user for review focus
        const focusOptions = [
            { label: 'All (Comprehensive)', value: 'all', description: 'Bugs, performance, security, style, side effects' },
            { label: 'Bugs Only', value: 'bugs', description: 'Logic errors, null handling, runtime crashes' },
            { label: 'Performance', value: 'performance', description: 'Inefficient algorithms, memory leaks' },
            { label: 'Security', value: 'security', description: 'Input validation, injection, auth gaps' },
            { label: 'Style', value: 'style', description: 'Readability, naming, DRY violations' }
        ];

        const selectedFocus = await vscode.window.showQuickPick(focusOptions, {
            placeHolder: 'Select review focus area',
            title: `LUNA: Review Changes in ${fileName}`
        });

        if (!selectedFocus) {
            return; // User cancelled
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `LUNA: Reviewing ${fileName} (${selectedFocus.label})...`,
            cancellable: true
        }, async (progress, token) => {
            try {
                const { execSync } = require('child_process');
                const fsModule = require('fs');

                progress.report({ message: `Selecting model: ${getConfiguredModelSelection().label}...` });
                const model = await requireConfiguredChatModel();

                // Read current file content
                let currentContent = '';
                try {
                    currentContent = fsModule.readFileSync(filePath, 'utf8');
                } catch {
                    vscode.window.showErrorMessage(`Cannot read file: ${filePath}`);
                    return;
                }

                // Get git diff
                progress.report({ message: 'Getting git diff...' });
                let diffContent = '';
                try {
                    diffContent = execSync(`git diff -- "${relativePath}"`, {
                        cwd: workspaceFolder.uri.fsPath,
                        encoding: 'utf8',
                        timeout: 10000
                    });
                    if (!diffContent.trim()) {
                        diffContent = execSync(`git diff --cached -- "${relativePath}"`, {
                            cwd: workspaceFolder.uri.fsPath,
                            encoding: 'utf8',
                            timeout: 10000
                        });
                    }
                    if (!diffContent.trim()) {
                        diffContent = execSync(`git diff HEAD~1 -- "${relativePath}"`, {
                            cwd: workspaceFolder.uri.fsPath,
                            encoding: 'utf8',
                            timeout: 10000
                        });
                    }
                } catch {
                    // No git diff available
                }

                if (!diffContent.trim()) {
                    const proceed = await vscode.window.showWarningMessage(
                        `No git changes detected for ${fileName}. Review the full file instead?`,
                        'Review Full File',
                        'Cancel'
                    );
                    if (proceed !== 'Review Full File') {
                        return;
                    }
                }

                // Get existing LUNA summary if available
                let summaryContext = '';
                const summaryJsonPath = path.join(workspaceFolder.uri.fsPath, '.codebase', relativePath.replace(/\.[^.]+$/, '.json'));
                try {
                    if (fsModule.existsSync(summaryJsonPath)) {
                        const summaryData = JSON.parse(fsModule.readFileSync(summaryJsonPath, 'utf8'));
                        const purpose = summaryData.summary?.purpose || '';
                        const components = (summaryData.summary?.keyComponents || []).map((c: any) => c.name).join(', ');
                        if (purpose) {
                            summaryContext = `\nLUNA Summary: ${purpose}`;
                            if (components) { summaryContext += ` | Components: ${components}`; }
                        }
                    }
                } catch {
                    // No summary available
                }

                // Build focus instructions
                const focusInstructions: Record<string, string> = {
                    all: 'Perform a comprehensive review covering bugs, performance, security, style, and side effects.',
                    bugs: 'Focus on logic errors, potential runtime errors, null/undefined handling, and off-by-one errors.',
                    performance: 'Focus on inefficient algorithms, memory leaks, unnecessary allocations, and O(n^2)+ operations.',
                    security: 'Focus on input validation, injection vulnerabilities, authentication gaps, and data exposure.',
                    style: 'Focus on code readability, naming conventions, function length, DRY violations, and maintainability.'
                };

                // Build review prompt
                let reviewPrompt = `You are a code reviewer. Review the changes to "${relativePath}".

REVIEW FOCUS: ${selectedFocus.value.toUpperCase()}
${focusInstructions[selectedFocus.value]}
${summaryContext}

`;
                if (diffContent.trim()) {
                    reviewPrompt += `GIT DIFF:\n\`\`\`diff\n${diffContent.trim()}\n\`\`\`\n\n`;
                }

                reviewPrompt += `CURRENT FILE:\n\`\`\`\n${currentContent}\n\`\`\`

For each issue, report:
- Severity: CRITICAL / HIGH / MEDIUM / LOW
- Category: BUG / PERFORMANCE / SECURITY / STYLE / SIDE_EFFECT  
- Line range
- Description and recommendation

End with a verdict: APPROVED, NEEDS_CHANGES, or BLOCKED with a brief overall assessment.
Be thorough but fair. Only flag real issues.`;

                // Call the model directly using the LM API
                progress.report({ message: `Reviewing with ${model.name}...` });
                const messages = [
                    vscode.LanguageModelChatMessage.User(reviewPrompt)
                ];

                const cancellationTokenSource = new vscode.CancellationTokenSource();
                // Link to the progress cancellation
                token.onCancellationRequested(() => cancellationTokenSource.cancel());

                const response = await model.sendRequest(messages, {}, cancellationTokenSource.token);

                // Stream result into a string
                let reviewResult = '';
                for await (const part of response.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        reviewResult += part.value;
                    }
                    if (token.isCancellationRequested) {
                        break;
                    }
                }

                if (token.isCancellationRequested) {
                    vscode.window.showInformationMessage('Review cancelled.');
                    return;
                }

                // Show results in an untitled document (closes clean, no files on disk)
                const header = `# Code Review: ${relativePath}\n\n` +
                    `**Model:** ${formatLanguageModel(model)}  \n` +
                    `**Focus:** ${selectedFocus.label}  \n` +
                    `**Date:** ${new Date().toLocaleString()}  \n\n---\n\n`;

                const doc = await vscode.workspace.openTextDocument({
                    content: header + reviewResult,
                    language: 'markdown'
                });
                await vscode.window.showTextDocument(doc, { preview: false });

                lunaOutputChannel.appendLine(`[Review] ${relativePath} reviewed with ${model.id} (focus: ${selectedFocus.value})`);
                vscode.window.showInformationMessage(`Review complete for ${fileName} (${model.name})`);

            } catch (error) {
                if (token.isCancellationRequested) {
                    vscode.window.showInformationMessage('Review cancelled.');
                } else {
                    vscode.window.showErrorMessage(`Failed to review file: ${error}`);
                }
            }
        });
    });

    // Project Health Report command - comprehensive project-wide analysis
    const projectHealthReportCommand = vscode.commands.registerCommand('luna-encyclopedia.projectHealthReport', async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }

        const codebasePath = path.join(workspaceFolder.uri.fsPath, '.codebase');
        if (!fs.existsSync(codebasePath)) {
            const action = await vscode.window.showWarningMessage(
                'No LUNA analysis data found. Generate summaries first?',
                'Generate Now',
                'Cancel'
            );
            if (action === 'Generate Now') {
                vscode.commands.executeCommand('luna-encyclopedia.generateSummaries');
            }
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'LUNA: Generating Project Health Report...',
            cancellable: true
        }, async (progress, token) => {
            try {
                progress.report({ message: `Selecting model: ${getConfiguredModelSelection().label}...` });
                const model = await requireConfiguredChatModel();

                // Load all available analysis data
                progress.report({ message: 'Loading analysis data...' });
                const loadJson = (fileName: string): any => {
                    const filePath = path.join(codebasePath, fileName);
                    if (fs.existsSync(filePath)) {
                        try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
                    }
                    return null;
                };

                const complexityHeatmap = loadJson('complexity-heatmap.json');
                const deadCode = loadJson('dead-code-analysis.json');
                const componentMap = loadJson('component-map.json');
                const dependencyGraph = loadJson('dependency-graph.json');
                const qaReport = loadJson('QA_REPORT.json');
                const apiReference = loadJson('api-reference.json');

                // Compute stats from the data
                let dataContext = '# Available Analysis Data\n\n';

                if (complexityHeatmap) {
                    const files = Array.isArray(complexityHeatmap) ? complexityHeatmap : (complexityHeatmap.files || []);
                    const critical = files.filter((f: any) => (f.score || f.complexity) >= 8);
                    const high = files.filter((f: any) => { const s = f.score || f.complexity; return s >= 6 && s < 8; });
                    const totalFiles = files.length;
                    dataContext += `## Complexity Heatmap (${totalFiles} files analyzed)\n`;
                    dataContext += `- Critical (8-10): ${critical.length} files\n`;
                    dataContext += `- High (6-7): ${high.length} files\n\n`;
                    if (critical.length > 0) {
                        dataContext += `### Critical Complexity Files:\n`;
                        critical.slice(0, 15).forEach((f: any) => {
                            dataContext += `- **${f.file || f.path}** - Score: ${f.score || f.complexity}/10 - ${f.reason || f.factors || ''}\n`;
                        });
                        dataContext += '\n';
                    }
                }

                if (deadCode) {
                    const entries = Array.isArray(deadCode) ? deadCode : (deadCode.unusedExports || deadCode.entries || []);
                    dataContext += `## Dead Code Analysis (${entries.length} unused exports found)\n`;
                    if (entries.length > 0) {
                        entries.slice(0, 20).forEach((e: any) => {
                            dataContext += `- **${e.export || e.name}** in ${e.file || e.sourceFile} ${e.aiVerdict ? `(AI: ${e.aiVerdict})` : ''}\n`;
                        });
                    }
                    dataContext += '\n';
                }

                if (componentMap) {
                    const components = Array.isArray(componentMap) ? componentMap : (componentMap.components || []);
                    dataContext += `## Component Map (${components.length} components detected)\n`;
                    components.forEach((c: any) => {
                        const fileCount = (c.files || []).length;
                        dataContext += `- **${c.name || c.component}** (${fileCount} files): ${c.description || c.purpose || ''}\n`;
                    });
                    dataContext += '\n';
                }

                if (dependencyGraph) {
                    const nodes = dependencyGraph.nodes || [];
                    const edges = dependencyGraph.edges || [];
                    dataContext += `## Dependency Graph (${nodes.length} nodes, ${edges.length} edges)\n`;
                    // Find most-depended-on files
                    const inDegree: Record<string, number> = {};
                    edges.forEach((e: any) => {
                        const target = e.to || e.target;
                        inDegree[target] = (inDegree[target] || 0) + 1;
                    });
                    const sorted = Object.entries(inDegree).sort((a, b) => b[1] - a[1]).slice(0, 10);
                    if (sorted.length > 0) {
                        dataContext += `### Most-depended-on files:\n`;
                        sorted.forEach(([file, count]) => {
                            dataContext += `- **${file}** (${count} dependents)\n`;
                        });
                    }
                    // Detect circular dependencies
                    const outEdges: Record<string, Set<string>> = {};
                    edges.forEach((e: any) => {
                        const from = e.from || e.source;
                        const to = e.to || e.target;
                        if (!outEdges[from]) { outEdges[from] = new Set(); }
                        outEdges[from].add(to);
                    });
                    const circularPairs: string[] = [];
                    Object.entries(outEdges).forEach(([from, tos]) => {
                        tos.forEach(to => {
                            if (outEdges[to]?.has(from) && from < to) {
                                circularPairs.push(`${from} <-> ${to}`);
                            }
                        });
                    });
                    if (circularPairs.length > 0) {
                        dataContext += `\n### Circular Dependencies Detected (${circularPairs.length}):\n`;
                        circularPairs.slice(0, 10).forEach(pair => {
                            dataContext += `- ${pair}\n`;
                        });
                    }
                    dataContext += '\n';
                }

                if (qaReport) {
                    dataContext += `## QA Report\n`;
                    dataContext += `\`\`\`json\n${JSON.stringify(qaReport, null, 2).substring(0, 2000)}\n\`\`\`\n\n`;
                }

                if (apiReference) {
                    const endpoints = apiReference.endpoints || [];
                    dataContext += `## API Reference (${endpoints.length} endpoints)\n`;
                    if (endpoints.length > 0) {
                        dataContext += `Frameworks: ${(apiReference.frameworks || []).join(', ')}\n\n`;
                    }
                }

                // Count total summary files
                let summaryCount = 0;
                const countJsonFiles = (dir: string) => {
                    try {
                        const entries = fs.readdirSync(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            if (entry.isDirectory()) { countJsonFiles(path.join(dir, entry.name)); }
                            else if (entry.name.endsWith('.json') && !['complexity-heatmap.json','dead-code-analysis.json','component-map.json','dependency-graph.json','QA_REPORT.json','api-reference.json'].includes(entry.name)) {
                                summaryCount++;
                            }
                        }
                    } catch { /* ignore */ }
                };
                countJsonFiles(codebasePath);
                dataContext += `## Summary Coverage: ${summaryCount} files summarized\n\n`;

                // Build the prompt for the AI
                const prompt = `You are a senior software architect preparing a comprehensive project health report. Analyze the following codebase analysis data and produce a clear, actionable report.

${dataContext}

Generate a well-structured markdown report with these sections:

# Project Health Report

## Executive Summary
A 3-4 sentence overview of the project's health. Is it in good shape? What are the biggest concerns?

## Health Score
Give the project an overall score from 1-10 and explain why. Consider:
- Code complexity distribution
- Dead code / unused exports  
- Architectural organization
- Dependency health (circular deps, coupling)
- Test coverage gaps (if detectable)

## Critical Issues (Fix Now)
Issues that will cause bugs, crashes, or maintenance nightmares. Be specific about what file and why.

## Technical Debt
- Complexity hotspots that need refactoring
- Dead code to remove
- Circular dependencies to break
- Files with too many responsibilities

## Architecture Assessment
- How well is the code organized?
- Are components well-separated?
- Are there clear boundaries?
- Recommendations for improvement

## Recommendations (Prioritized)
Numbered list, most important first. Each recommendation should be:
1. Specific (which file/component)
2. Actionable (what exactly to do)
3. Justified (why it matters)

Be honest and specific. Don't pad with generic advice. If the codebase is in good shape, say so.`;

                progress.report({ message: 'AI analyzing project health...' });
                const cancellationTokenSource = new vscode.CancellationTokenSource();
                token.onCancellationRequested(() => cancellationTokenSource.cancel());

                const response = await model.sendRequest(
                    [vscode.LanguageModelChatMessage.User(prompt)],
                    {},
                    cancellationTokenSource.token
                );

                let result = '';
                for await (const part of response.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        result += part.value;
                    }
                    if (token.isCancellationRequested) { break; }
                }

                if (token.isCancellationRequested) {
                    vscode.window.showInformationMessage('Report generation cancelled.');
                    return;
                }

                const header = `<!-- Generated by LUNA Codebase Encyclopedia -->\n` +
                    `<!-- Model: ${model.id} | Date: ${new Date().toLocaleString()} -->\n\n`;

                const doc = await vscode.workspace.openTextDocument({
                    content: header + result,
                    language: 'markdown'
                });
                await vscode.window.showTextDocument(doc, { preview: false });

                lunaOutputChannel.appendLine(`[HealthReport] Generated with ${model.id}`);
                vscode.window.showInformationMessage(`Project Health Report generated (${model.name})`);

            } catch (error) {
                if (token.isCancellationRequested) {
                    vscode.window.showInformationMessage('Report cancelled.');
                } else {
                    vscode.window.showErrorMessage(`Failed to generate health report: ${error}`);
                }
            }
        });
    });

    // Suggest Refactorings command - AI-powered refactoring recommendations for high-complexity files
    const suggestRefactoringsCommand = vscode.commands.registerCommand('luna-encyclopedia.suggestRefactorings', async (fileUri?: vscode.Uri) => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }

        const codebasePath = path.join(workspaceFolder.uri.fsPath, '.codebase');

        // Determine which files to analyze
        let targetFiles: { file: string; score: number; reason?: string }[] = [];

        if (fileUri) {
            // Specific file from context menu
            const relativePath = path.relative(workspaceFolder.uri.fsPath, fileUri.fsPath);
            targetFiles = [{ file: relativePath, score: 0, reason: 'User selected' }];
        } else if (vscode.window.activeTextEditor) {
            // Current file in editor
            const relativePath = path.relative(workspaceFolder.uri.fsPath, vscode.window.activeTextEditor.document.uri.fsPath);
            targetFiles = [{ file: relativePath, score: 0, reason: 'Current file' }];
        } else {
            // No file specified - use complexity heatmap to find worst files
            const heatmapPath = path.join(codebasePath, 'complexity-heatmap.json');
            if (!fs.existsSync(heatmapPath)) {
                vscode.window.showWarningMessage('No complexity data found. Run "LUNA: Generate Codebase Summaries" first.');
                return;
            }
            try {
                const heatmap = JSON.parse(fs.readFileSync(heatmapPath, 'utf8'));
                const files = Array.isArray(heatmap) ? heatmap : (heatmap.files || []);
                targetFiles = files
                    .filter((f: any) => (f.score || f.complexity) >= 7)
                    .sort((a: any, b: any) => (b.score || b.complexity) - (a.score || a.complexity))
                    .slice(0, 5)
                    .map((f: any) => ({
                        file: f.file || f.path,
                        score: f.score || f.complexity,
                        reason: f.reason || f.factors || ''
                    }));
            } catch {
                vscode.window.showErrorMessage('Failed to read complexity heatmap.');
                return;
            }

            if (targetFiles.length === 0) {
                vscode.window.showInformationMessage('No high-complexity files found (all below 7/10). Your codebase is in great shape!');
                return;
            }

            // Let user pick which files to refactor or do all
            const choices = [
                { label: `All ${targetFiles.length} files (complexity 7+)`, value: 'all', description: targetFiles.map(f => path.basename(f.file)).join(', ') },
                ...targetFiles.map(f => ({
                    label: `${path.basename(f.file)} (${f.score}/10)`,
                    value: f.file,
                    description: f.reason || ''
                }))
            ];

            const selected = await vscode.window.showQuickPick(choices, {
                placeHolder: 'Select file(s) to get refactoring suggestions for',
                title: 'LUNA: Suggest Refactorings'
            });

            if (!selected) { return; }
            if (selected.value !== 'all') {
                targetFiles = targetFiles.filter(f => f.file === selected.value);
            }
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `LUNA: Analyzing ${targetFiles.length} file(s) for refactoring...`,
            cancellable: true
        }, async (progress, token) => {
            try {
                progress.report({ message: `Selecting model: ${getConfiguredModelSelection().label}...` });
                const model = await requireConfiguredChatModel();

                // Read file contents and LUNA summaries
                let fileContexts = '';
                for (const target of targetFiles) {
                    progress.report({ message: `Reading ${path.basename(target.file)}...` });
                    const fullPath = path.join(workspaceFolder.uri.fsPath, target.file);
                    let content = '';
                    try {
                        content = fs.readFileSync(fullPath, 'utf8');
                    } catch {
                        fileContexts += `\n## ${target.file} (COULD NOT READ)\n\n`;
                        continue;
                    }

                    fileContexts += `\n## ${target.file} (Complexity: ${target.score}/10)\n`;
                    if (target.reason) { fileContexts += `Complexity factors: ${target.reason}\n`; }

                    // Check for LUNA summary
                    const summaryPath = path.join(codebasePath, target.file.replace(/\.[^.]+$/, '.json'));
                    try {
                        if (fs.existsSync(summaryPath)) {
                            const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
                            fileContexts += `Purpose: ${summary.summary?.purpose || 'Unknown'}\n`;
                            fileContexts += `Components: ${(summary.summary?.keyComponents || []).map((c: any) => c.name).join(', ')}\n`;
                        }
                    } catch { /* no summary */ }

                    fileContexts += `\n\`\`\`\n${content}\n\`\`\`\n`;
                }

                const prompt = `You are a senior software engineer specializing in code refactoring. Analyze the following high-complexity file(s) and provide specific, actionable refactoring recommendations.

${fileContexts}

For EACH file, provide:

### [filename] - Refactoring Plan

**Current Issues:**
- What makes this file complex
- Specific code smells detected

**Recommended Refactorings (prioritized):**
For each refactoring:
1. **What:** Name the refactoring pattern (Extract Method, Split Class, etc.)
2. **Where:** Specific functions/lines to change
3. **Why:** What problem it solves
4. **How:** Brief description of the approach
5. **Estimated Complexity After:** What the new score would be

**Quick Wins (< 5 min):**
- Simple improvements that make an immediate difference

**Structural Changes (30+ min):**
- Larger refactorings for significant improvement

Be specific with function names and line references. Don't suggest renaming variables or adding comments -- focus on structural improvements that reduce complexity. If a file is actually well-structured despite high complexity, say so.`;

                progress.report({ message: 'AI analyzing refactoring opportunities...' });
                const cancellationTokenSource = new vscode.CancellationTokenSource();
                token.onCancellationRequested(() => cancellationTokenSource.cancel());

                const response = await model.sendRequest(
                    [vscode.LanguageModelChatMessage.User(prompt)],
                    {},
                    cancellationTokenSource.token
                );

                let result = '';
                for await (const part of response.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        result += part.value;
                    }
                    if (token.isCancellationRequested) { break; }
                }

                if (token.isCancellationRequested) {
                    vscode.window.showInformationMessage('Refactoring analysis cancelled.');
                    return;
                }

                const header = `# Refactoring Suggestions\n\n` +
                    `**Model:** ${formatLanguageModel(model)}  \n` +
                    `**Files Analyzed:** ${targetFiles.map(f => f.file).join(', ')}  \n` +
                    `**Date:** ${new Date().toLocaleString()}  \n\n---\n\n`;

                const doc = await vscode.workspace.openTextDocument({
                    content: header + result,
                    language: 'markdown'
                });
                await vscode.window.showTextDocument(doc, { preview: false });

                lunaOutputChannel.appendLine(`[Refactoring] ${targetFiles.length} files analyzed with ${model.id}`);
                vscode.window.showInformationMessage(`Refactoring suggestions generated for ${targetFiles.length} file(s)`);

            } catch (error) {
                if (token.isCancellationRequested) {
                    vscode.window.showInformationMessage('Analysis cancelled.');
                } else {
                    vscode.window.showErrorMessage(`Failed to analyze: ${error}`);
                }
            }
        });
    });

    // Backup All Chat Sessions command
    const backupChatsCommand = vscode.commands.registerCommand('luna-encyclopedia.backupChatSessions', async () => {
        if (!chatSessionMonitor) {
            vscode.window.showErrorMessage('Chat session monitor not initialized.');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'LUNA: Backing up chat sessions...',
            cancellable: false
        }, async (progress) => {
            const result = await chatSessionMonitor!.backupAllSessions();
            vscode.window.showInformationMessage(
                `Backed up ${result.sessions} session(s) with ${result.turns} total turn(s) to .codebase/chat-history/`
            );
        });
    });

    // View Chat Activity Digest command
    const chatDigestCommand = vscode.commands.registerCommand('luna-encyclopedia.chatActivityDigest', async () => {
        if (!chatSessionMonitor) {
            vscode.window.showErrorMessage('Chat session monitor not initialized.');
            return;
        }

        const daysOptions = [
            { label: 'Last 24 hours', value: 1 },
            { label: 'Last 7 days', value: 7 },
            { label: 'Last 30 days', value: 30 },
            { label: 'All time', value: 3650 }
        ];

        const selected = await vscode.window.showQuickPick(daysOptions, {
            placeHolder: 'Select time range for activity digest',
            title: 'LUNA: Chat Activity Digest'
        });

        if (!selected) { return; }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'LUNA: Generating activity digest...',
            cancellable: false
        }, async () => {
            const digest = await chatSessionMonitor!.generateSessionDigest(selected.value);
            const doc = await vscode.workspace.openTextDocument({
                content: digest,
                language: 'markdown'
            });
            await vscode.window.showTextDocument(doc, { preview: false });
        });
    });

    context.subscriptions.push(
        initCommand,
        generateCommand, 
        updateStaleCommand,
        regenerateMetaCommand,
        showSummaryCommand, 
        refreshCommand,
        summarizeFileCommand,
        previewFilesCommand,
        generateBreakdownCommand,
        selectSummaryModelCommand,
        showAvailableModelsCommand,
        reviewFileChangesCommand,
        projectHealthReportCommand,
        suggestRefactoringsCommand,
        backupChatsCommand,
        chatDigestCommand,
        resetCommand,
        reregisterMCPCommand,
        treeView,
        uriHandler,
        watcher
    );

    // Register worker agent commands for MCP server
    context.subscriptions.push(
        vscode.commands.registerCommand('luna.submitBackgroundTask', async (taskType, prompt, options) => {
            return await taskManager.submitTask(taskType, prompt, options);
        }),
        vscode.commands.registerCommand('luna.getBackgroundTask', (taskId) => {
            return taskManager.getTaskStatus(taskId);
        }),
        vscode.commands.registerCommand('luna.listBackgroundTasks', (statusFilter?) => {
            return taskManager.getAllTasks(statusFilter);
        }),
        vscode.commands.registerCommand('luna.waitForBackgroundTasks', async (taskIds?, timeoutSeconds?) => {
            return await taskManager.waitForTasks(taskIds, timeoutSeconds);
        }),
        vscode.commands.registerCommand('luna.cancelBackgroundTask', (taskId) => {
            return taskManager.cancelTask(taskId);
        }),
        vscode.commands.registerCommand('luna.clearCompletedTasks', () => {
            return taskManager.clearCompletedTasks();
        }),
        vscode.commands.registerCommand('luna.getWorkerStats', () => {
            return taskManager.getStats();
        })
    );

    // Check if workspace needs initialization (AFTER commands are registered, non-blocking)
    checkAndPromptInitialization(codebaseAnalyzer).catch(err => {
        console.error('Failed to check initialization:', err);
    });
}

async function checkAndPromptInitialization(codebaseAnalyzer: any) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return; // No workspace open
    }

    const fs = require('fs');
    const codebasePath = path.join(workspaceFolder.uri.fsPath, '.codebase');
    
    // Check if .codebase directory exists
    if (!fs.existsSync(codebasePath)) {
        const action = await vscode.window.showInformationMessage(
            '🚀 Welcome to LUNA! Would you like to set up your codebase encyclopedia?',
            'Initialize Now',
            'Not Now',
            'Learn More'
        );

        if (action === 'Initialize Now') {
            vscode.commands.executeCommand('luna-encyclopedia.initialize');
        } else if (action === 'Learn More') {
            vscode.env.openExternal(vscode.Uri.parse('https://github.com/yourusername/LUNA-VSCode-Codebase-Encyclopeda#readme'));
        }
    }
}

async function registerMCPServer(context: vscode.ExtensionContext, forceRestart: boolean = false) {
    const mcpServerPath = path.join(context.extensionPath, 'mcp-server', 'dist', 'index.js');
    const config = vscode.workspace.getConfiguration();
    const mcpServers = config.get<Record<string, any>>('mcp.servers', {});

    const existingServer = mcpServers['lunaEncyclopedia'];
    const isFirstTime = !existingServer;
    
    // Detect if the MCP server path has changed (e.g., after reinstall/update)
    const existingPath = existingServer?.args?.[0];
    const pathChanged = existingPath && existingPath !== mcpServerPath;
    
    // For dev workflow: always restart if server exists (files may have changed on disk)
    const shouldRestart = forceRestart || pathChanged || existingServer;

    try {
        // Register single global MCP server
        await config.update('mcp.servers', {
            ...mcpServers,
            lunaEncyclopedia: {
                type: 'stdio',
                command: 'node',
                args: [mcpServerPath]
            }
        }, vscode.ConfigurationTarget.Global);

        lunaOutputChannel.appendLine(`✅ MCP server registered at: ${mcpServerPath}`);
        
        if (shouldRestart && !isFirstTime) {
            // Always try to restart existing MCP server to pick up file changes
            lunaOutputChannel.appendLine('🔄 Restarting MCP server to pick up any changes...');
            
            try {
                await vscode.commands.executeCommand('mcp.restartServer', 'lunaEncyclopedia');
                lunaOutputChannel.appendLine('✅ MCP server restarted successfully');
            } catch {
                // Command might not exist in older VS Code versions - that's okay
                lunaOutputChannel.appendLine('ℹ️ Auto-restart not available. Use "LUNA: Re-register MCP Server" if needed.');
            }
        } else if (isFirstTime) {
            vscode.window.showInformationMessage(
                '✅ LUNA MCP Server registered! Copilot Agent Mode can now query your codebase summaries.',
                'Open Copilot Chat'
            ).then(selection => {
                if (selection === 'Open Copilot Chat') {
                    vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
                }
            });
        }
    } catch (error) {
        console.error('Failed to register LUNA MCP server:', error);
        lunaOutputChannel.appendLine(`❌ Failed to register MCP server: ${error}`);
        vscode.window.showWarningMessage(
            'LUNA: Could not auto-register MCP server. Try running "LUNA: Re-register MCP Server" from the command palette.'
        );
    }
}

async function unregisterMCPServer(context: vscode.ExtensionContext) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        return;
    }

    const workspaceName = workspaceFolder.name;
    const serverName = `lunaEncyclopedia-${workspaceName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    
    const config = vscode.workspace.getConfiguration();
    const mcpServers = config.get<Record<string, any>>('mcp.servers', {});
    
    if (mcpServers[serverName]) {
        delete mcpServers[serverName];
        await config.update('mcp.servers', mcpServers, vscode.ConfigurationTarget.Global);
        console.log('LUNA MCP server unregistered:', serverName);
    }
}

export function deactivate() {
    // Stop git commit watcher on deactivation
    if (gitCommitWatcher) {
        gitCommitWatcher.stop();
    }

    // Stop chat session monitor
    if (chatSessionMonitor) {
        chatSessionMonitor.stop();
    }
    
    // Stop extension bridge server
    if (extensionBridge) {
        extensionBridge.stop().catch(err => {
            console.error('Failed to stop extension bridge:', err);
        });
    }
    
    // Clean up bridge port file
    try {
        const bridgePortFile = path.join(os.homedir(), '.luna-bridge-port');
        if (fs.existsSync(bridgePortFile)) {
            fs.unlinkSync(bridgePortFile);
        }
    } catch (error) {
        console.error('Failed to clean up bridge port file:', error);
    }
    
    // Note: We don't unregister MCP server here because VS Code might just be reloading
    // User can manually clean up old servers if needed
}

