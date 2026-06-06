import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SummaryIncludeMatcher } from './summaryIncludeMatcher';
import { DirectoryTreeBuilder } from './directoryTreeBuilder';
import { StalenessDetector } from './stalenessDetector';
import { DependencyLinker } from './dependencyLinker';
import { SummaryIssueTracker } from './summaryIssueTracker';
import { ConcurrencyLimiter } from './concurrencyLimiter';
import { GitBranchDetector } from './gitBranchDetector';
import { StaticImportAnalyzer } from './staticImportAnalyzer';
import { DependencyAnalyzer } from './dependencyAnalyzer';
import { QualityAssuranceValidator } from './qualityAssuranceValidator';
import { EnhancedDeadCodeDetector } from './enhancedDeadCodeDetector';
import { PromptManager } from './promptManager';
import { APIReferenceGenerator } from './apiReferenceGenerator';
import { getConfiguredModelSelection } from './modelSelection';

interface FileSummary {
    purpose: string;
    keyComponents: Array<{ 
        name: string; 
        description: string;
        lines?: string; // e.g., "123-168" or "42"
    }>;
    dependencies: {
        internal: Array<{ 
            path: string; 
            usage: string;
            lines?: string; // Where the import/usage occurs
        }>;
        external: Array<{ 
            package: string; 
            usage: string;
            lines?: string; // Where the import/usage occurs
        }>;
    };
    publicAPI: Array<{ 
        signature: string; 
        description: string;
        lines?: string; // Where this API is defined
    }>;
    codeLinks: Array<{ 
        symbol: string; 
        path: string;
        lines?: string; // Line range for this symbol
    }>;
    usedBy?: Array<{
        file: string;
        usage: string;
        lines?: string; // Where this file is used by the other file
    }>;
    implementationNotes: string;
    // Custom fields from .luna-template.json
    [key: string]: any;
}

export class CodebaseAnalyzer {
    private getModelSelector(): vscode.LanguageModelChatSelector {
        return getConfiguredModelSelection().selector;
    }
    
    constructor(
        private context: vscode.ExtensionContext,
        private outputChannel?: vscode.OutputChannel
    ) {}

    private log(message: string): void {
        if (this.outputChannel) {
            this.outputChannel.appendLine(message);
        }
        console.log(message);
    }

    async updateStaleSummaries(
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }

        const branchAware = vscode.workspace.getConfiguration('luna-encyclopedia').get<boolean>('branchAwareSummaries', false);

        // Check if Language Model API is available
        const modelSelector = this.getModelSelector();
        const models = await vscode.lm.selectChatModels(modelSelector);
        if (models.length === 0) {
            const modelName = modelSelector.id || modelSelector.family || 'unknown';
            throw new Error(`No language model "${modelName}" available.`);
        }

        // Discover files
        progress.report({ message: 'Discovering files...' });
        const files = await this.discoverFiles(workspaceFolder.uri.fsPath);
        
        if (files.length === 0) {
            throw new Error('No source files found');
        }

        // Remove summaries for files that no longer exist
        progress.report({ message: 'Checking for orphaned summaries...' });
        const removed = this.removeOrphanedSummaries(workspaceFolder.uri.fsPath, files);
        if (removed > 0) {
            this.log(`Removed ${removed} orphaned summary file(s)`);
        }

        // Check staleness
        progress.report({ message: 'Checking for stale summaries...' });
        const report = StalenessDetector.getStalenessReport(workspaceFolder.uri.fsPath, files, branchAware);

        if (report.staleFiles.length === 0) {
            // No stale file summaries, but still regenerate meta-summaries
            // (code may have changed in ways that affect complexity, dead code, dependencies, etc.)
            progress.report({ message: 'File summaries up-to-date. Regenerating meta-analysis...' });
            await this.regenerateMetaSummaries(progress, token);
            vscode.window.showInformationMessage(`All ${report.total} summaries up-to-date. Meta-analysis regenerated! ✅`);
            return;
        }

        const updateConfirm = await vscode.window.showInformationMessage(
            `Found ${report.staleFiles.length} stale summaries (${report.missing} missing, ${report.stale} outdated). Update?`,
            'Yes', 'No'
        );

        if (updateConfirm !== 'Yes') {
            return;
        }

        // Update only stale files using parallel processing
        const concurrentWorkers = vscode.workspace.getConfiguration('luna-encyclopedia')
            .get<number>('concurrentWorkers', 5);
        const limiter = new ConcurrencyLimiter(concurrentWorkers);
        const total = report.staleFiles.length;
        let completed = 0;

        const updatePromises = report.staleFiles.map((staleInfo, index) =>
            limiter.run(async () => {
                if (token.isCancellationRequested) {
                    throw new Error('Cancelled by user');
                }

                const relPath = path.relative(workspaceFolder.uri.fsPath, staleInfo.filePath);
                progress.report({ 
                    message: `[${completed + 1}/${total}] ${relPath} (${limiter.getRunning()} running, ${limiter.getQueued()} queued)`,
                    increment: (100 / total)
                });

                try {
                    await this.analyzeSingleFile(staleInfo.filePath, workspaceFolder.uri.fsPath, models[0]);
                } catch (error) {
                    this.log(`Failed to update ${relPath}: ${error}`);
                    console.error(error);
                }
                
                completed++;
            })
        );

        // Wait for all updates to complete
        await Promise.all(updatePromises);

        // Rebuild directory index files so *.index.md / *.index.json reflect current state
        progress.report({ message: 'Regenerating directory indices...' });
        const includeMatcher = new SummaryIncludeMatcher(workspaceFolder.uri.fsPath);
        const tree = DirectoryTreeBuilder.buildTree(workspaceFolder.uri.fsPath, files, []);
        const directories = DirectoryTreeBuilder.getDirectoriesBottomUp(tree);
        for (const dir of directories) {
            if (token.isCancellationRequested) { break; }
            await this.generateDirectoryIndex(dir, workspaceFolder.uri.fsPath, tree);
        }
        await this.generateRootIndex(tree, workspaceFolder.uri.fsPath);

        // Regenerate meta-summaries since file summaries changed
        progress.report({ message: 'Regenerating meta-analysis...' });
        await this.regenerateMetaSummaries(progress, token);
    }

    /**
     * Walk .codebase/ and delete .md/.json summary pairs whose source file no longer exists.
     * Skips meta-analysis files (complexity-heatmap.json, etc.) and index files.
     * Returns the number of source summaries removed.
     */
    private removeOrphanedSummaries(workspacePath: string, currentFiles: string[]): number {
        const codebasePath = path.join(workspacePath, '.codebase');
        if (!fs.existsSync(codebasePath)) { return 0; }

        // Build a set of known source paths for O(1) lookup
        const knownSources = new Set(currentFiles.map(f => path.resolve(f)));

        // Meta-analysis filenames that live directly in .codebase/ — never orphans
        const metaFiles = new Set([
            'complexity-heatmap.json',
            'component-map.json',
            'dependency-graph.json',
            'dead-code-analysis.json',
            'QA_REPORT.json',
            'SUMMARY_REPORT.md',
            'api-reference.json',
            '.lunasummarize',
            '.luna-template.json',
            '.luna-template.json.example',
            '.tracking-state.json',
        ]);

        let removed = 0;

        const walkAndClean = (dir: string) => {
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
            catch { return; }

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    // Recurse — but skip chat-history and mcp-server subdirs
                    if (entry.name === 'chat-history' || entry.name === 'mcp-server') { continue; }
                    walkAndClean(fullPath);
                    // Remove now-empty directories (best-effort)
                    try {
                        if (fs.readdirSync(fullPath).length === 0) {
                            fs.rmdirSync(fullPath);
                        }
                    } catch { /* ignore */ }
                    continue;
                }

                if (!entry.isFile()) { continue; }

                // Skip meta-analysis files at root of .codebase/
                if (dir === codebasePath && metaFiles.has(entry.name)) { continue; }

                // Only process .json file summaries (each one represents a source file)
                if (!entry.name.endsWith('.json')) { continue; }

                // Skip index files (e.g. src.index.json, foldername.index.json)
                if (entry.name.includes('.index.')) { continue; }

                // Read sourceFile from the JSON metadata
                let sourceRelPath: string | undefined;
                try {
                    const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
                    sourceRelPath = data.sourceFile;
                } catch { continue; } // Malformed JSON — leave it alone

                if (!sourceRelPath) { continue; } // Not a file summary

                const absoluteSourcePath = path.resolve(workspacePath, sourceRelPath);

                if (!knownSources.has(absoluteSourcePath)) {
                    // Source file is gone — remove both .json and .md
                    const basePath = fullPath.replace(/(\.\w+)?\.json$/, '');
                    for (const ext of ['.json', '.md']) {
                        const target = basePath + ext;
                        if (fs.existsSync(target)) {
                            try { fs.unlinkSync(target); } catch { /* ignore */ }
                        }
                    }
                    // Also handle branch-suffixed variants (e.g. foo.main.json)
                    const dir2 = path.dirname(fullPath);
                    const base = path.basename(fullPath, '.json').replace(/\.[^.]+$/, ''); // strip branch suffix too
                    try {
                        const siblings = fs.readdirSync(dir2);
                        for (const sibling of siblings) {
                            if (sibling.startsWith(base + '.') && (sibling.endsWith('.json') || sibling.endsWith('.md'))) {
                                try { fs.unlinkSync(path.join(dir2, sibling)); } catch { /* ignore */ }
                            }
                        }
                    } catch { /* ignore */ }
                    removed++;
                    this.log(`Removed orphaned summary: ${sourceRelPath}`);
                }
            }
        };

        walkAndClean(codebasePath);
        return removed;
    }

    async initializeWorkspace(
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }

        progress.report({ message: 'Initializing LUNA...' });

        // Create .codebase directory
        const codebasePath = path.join(workspaceFolder.uri.fsPath, '.codebase');
        if (!fs.existsSync(codebasePath)) {
            fs.mkdirSync(codebasePath, { recursive: true });
        }

        // Create .lunasummarize config if it doesn't exist
        const lunaSummarizePath = path.join(codebasePath, '.lunasummarize');
        if (!fs.existsSync(lunaSummarizePath)) {
            progress.report({ message: 'Creating .lunasummarize config...' });
            const templatePath = path.join(this.context.extensionPath, 'resources', 'templates', '.lunasummarize');
            if (!fs.existsSync(templatePath)) {
                throw new Error(`Template not found: ${templatePath}`);
            }
            fs.copyFileSync(templatePath, lunaSummarizePath);
        }

        // Create instructions if they don't exist
        const instructionsPath = path.join(codebasePath, 'COPILOT_INSTRUCTIONS.md');
        if (!fs.existsSync(instructionsPath)) {
            progress.report({ message: 'Creating COPILOT_INSTRUCTIONS.md...' });
            const templatePath = path.join(this.context.extensionPath, 'resources', 'templates', 'COPILOT_INSTRUCTIONS.md');
            if (!fs.existsSync(templatePath)) {
                throw new Error(`Template not found: ${templatePath}`);
            }
            fs.copyFileSync(templatePath, instructionsPath);
        }

        // Create README for .codebase directory
        const readmePath = path.join(codebasePath, 'USER_README.md');
        if (!fs.existsSync(readmePath)) {
            progress.report({ message: 'Creating .codebase/USER_README.md...' });
            const templatePath = path.join(this.context.extensionPath, 'resources', 'templates', 'USER_README.md');
            if (!fs.existsSync(templatePath)) {
                throw new Error(`Template not found: ${templatePath}`);
            }
            fs.copyFileSync(templatePath, readmePath);
        }

        // Create .luna-template.json.example if it doesn't exist
        const templateExamplePath = path.join(codebasePath, '.luna-template.json.example');
        if (!fs.existsSync(templateExamplePath)) {
            progress.report({ message: 'Creating .luna-template.json.example...' });
            const exampleTemplatePath = path.join(this.context.extensionPath, 'resources', 'templates', '.luna-template.json.example');
            if (!fs.existsSync(exampleTemplatePath)) {
                throw new Error(`Template not found: ${exampleTemplatePath}`);
            }
            fs.copyFileSync(exampleTemplatePath, templateExamplePath);
        }

        // Create luna-encyclopedia.instructions.md for AI tools quick reference
        const lunaInstructionsPath = path.join(codebasePath, 'luna-encyclopedia.instructions.md');
        if (!fs.existsSync(lunaInstructionsPath)) {
            progress.report({ message: 'Creating luna-encyclopedia.instructions.md...' });
            const lunaInstructionsTemplatePath = path.join(this.context.extensionPath, 'resources', 'templates', 'luna-encyclopedia.instructions.md');
            if (!fs.existsSync(lunaInstructionsTemplatePath)) {
                throw new Error(`Template not found: ${lunaInstructionsTemplatePath}`);
            }
            fs.copyFileSync(lunaInstructionsTemplatePath, lunaInstructionsPath);
        }

        progress.report({ message: 'Initialization complete!' });
        
        // Open Quick Start guide from extension resources (don't copy to workspace)
        const quickStartPath = path.join(this.context.extensionPath, 'resources', 'templates', 'QUICK_START.md');
        const quickStartDoc = await vscode.workspace.openTextDocument(quickStartPath);
        await vscode.window.showTextDocument(quickStartDoc, { preview: false, viewColumn: vscode.ViewColumn.One });
        
        // Open .lunasummarize for editing in split view
        const configDoc = await vscode.workspace.openTextDocument(lunaSummarizePath);
        await vscode.window.showTextDocument(configDoc, { preview: false, viewColumn: vscode.ViewColumn.Two });
        
        vscode.window.showInformationMessage(
            '✅ LUNA initialized! Follow the Quick Start guide to configure and generate summaries.'
        );
    }

    async generateSummaries(
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }

        // Check if Language Model API is available
        const modelSelector = this.getModelSelector();
        const models = await vscode.lm.selectChatModels(modelSelector);
        if (models.length === 0) {
            const modelName = modelSelector.id || modelSelector.family || 'unknown';
            throw new Error(`No language model "${modelName}" available. Please ensure the provider extension is installed and active, or try a different model in settings.`);
        }

        // Discover files
        progress.report({ message: 'Discovering files...' });
        const files = await this.discoverFiles(workspaceFolder.uri.fsPath);
        
        if (files.length === 0) {
            throw new Error('No source files found');
        }

        // Initialize issue tracker
        const issueTracker = new SummaryIssueTracker();
        const maxFileSize = vscode.workspace.getConfiguration('luna-encyclopedia').get<number>('maxFileSize', 500); // in KB

        // Check for oversized files upfront
        for (const file of files) {
            try {
                const stats = fs.statSync(file);
                const fileSizeKB = stats.size / 1024;
                if (fileSizeKB > maxFileSize) {
                    issueTracker.addIssue(
                        path.relative(workspaceFolder.uri.fsPath, file),
                        'file-too-large',
                        `File size ${fileSizeKB.toFixed(1)}KB exceeds limit of ${maxFileSize}KB`,
                        fileSizeKB
                    );
                }
            } catch (error) {
                console.error(`Failed to stat ${file}:`, error);
            }
        }

        // Create .codebase directory
        const codebasePath = path.join(workspaceFolder.uri.fsPath, '.codebase');
        if (!fs.existsSync(codebasePath)) {
            fs.mkdirSync(codebasePath, { recursive: true });
        }
        
        // Ensure config and instructions exist (in case user skipped init)
        const lunaSummarizePath = path.join(codebasePath, '.lunasummarize');
        if (!fs.existsSync(lunaSummarizePath)) {
            const templatePath = path.join(this.context.extensionPath, 'resources', 'templates', '.lunasummarize');
            fs.copyFileSync(templatePath, lunaSummarizePath);
        }

        const instructionsPath = path.join(codebasePath, 'COPILOT_INSTRUCTIONS.md');
        if (!fs.existsSync(instructionsPath)) {
            const templatePath = path.join(this.context.extensionPath, 'resources', 'templates', 'COPILOT_INSTRUCTIONS.md');
            fs.copyFileSync(templatePath, instructionsPath);
        }
        
        // Build directory tree and create placeholders
        progress.report({ message: `Building directory tree (${files.length} files)...` });
        const includeMatcher = new SummaryIncludeMatcher(workspaceFolder.uri.fsPath);
        const tree = DirectoryTreeBuilder.buildTree(workspaceFolder.uri.fsPath, files, []);

        progress.report({ message: 'Creating file structure...' });
        DirectoryTreeBuilder.createPlaceholders(workspaceFolder.uri.fsPath, tree, files);

        // Get files in bottom-up order (deepest first)
        const orderedFiles = DirectoryTreeBuilder.getFilesBottomUp(tree);
        
        console.log('[LUNA DEBUG] Files after buildTree:', files.length);
        console.log('[LUNA DEBUG] Files after getFilesBottomUp:', orderedFiles.length);
        console.log('[LUNA DEBUG] Missing files:', files.filter(f => !orderedFiles.includes(f)).map(f => path.relative(workspaceFolder.uri.fsPath, f)));

        // Analyze files in parallel with configurable worker count
        const concurrentWorkers = vscode.workspace.getConfiguration('luna-encyclopedia')
            .get<number>('concurrentWorkers', 5);
        const limiter = new ConcurrencyLimiter(concurrentWorkers);
        const total = orderedFiles.length;
        let completed = 0;

        const analysisPromises = orderedFiles.map((file, index) => 
            limiter.run(async () => {
                if (token.isCancellationRequested) {
                    throw new Error('Cancelled by user');
                }

                const relPath = path.relative(workspaceFolder.uri.fsPath, file);
                progress.report({ 
                    message: `[${completed + 1}/${total}] ${relPath} (${limiter.getRunning()} running, ${limiter.getQueued()} queued)`,
                    increment: (100 / total)
                });

                try {
                    await this.analyzeSingleFile(file, workspaceFolder.uri.fsPath, models[0]);
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    
                    if (errorMsg.includes('timeout')) {
                        issueTracker.addIssue(relPath, 'timeout', `Timeout analyzing file: ${errorMsg}`);
                    } else if (errorMsg.includes('parse') || errorMsg.includes('syntax')) {
                        issueTracker.addIssue(relPath, 'parse-error', `Parse error: ${errorMsg}`);
                    } else if (errorMsg.includes('API') || errorMsg.includes('rate')) {
                        issueTracker.addIssue(relPath, 'api-error', `API error: ${errorMsg}`);
                    } else {
                        issueTracker.addIssue(relPath, 'api-error', `Failed to analyze: ${errorMsg}`);
                    }
                    
                    console.error(`Failed to analyze ${relPath}:`, error);
                }
                
                completed++;
            })
        );

        // Wait for all analyses to complete
        await Promise.all(analysisPromises);

        // Generate INDEX.md files for directories (bottom-up)
        progress.report({ message: 'Generating directory indices...' });
        const directories = DirectoryTreeBuilder.getDirectoriesBottomUp(tree);
        for (const dir of directories) {
            if (token.isCancellationRequested) {
                throw new Error('Cancelled by user');
            }
            await this.generateDirectoryIndex(dir, workspaceFolder.uri.fsPath, tree);
        }

        // Generate root INDEX.md
        progress.report({ message: 'Generating root index...' });
        await this.generateRootIndex(tree, workspaceFolder.uri.fsPath);

        // Compute bidirectional "Used By" relationships
        progress.report({ message: 'Computing dependency relationships...' });
        DependencyLinker.computeUsedByRelationships(workspaceFolder.uri.fsPath, codebasePath);

        // Analyze code structure for components and complexity
        progress.report({ message: 'Analyzing codebase structure...' });
        const analyzer = new DependencyAnalyzer();
        await analyzer.analyze(workspaceFolder.uri.fsPath);

        // Enhanced dead code detection (uses JSON summaries + AST parsing)
        progress.report({ message: 'Detecting dead code with AST analysis...' });
        const deadCodeDetector = new EnhancedDeadCodeDetector();
        const orphanedExports = await deadCodeDetector.analyze(codebasePath, workspaceFolder.uri.fsPath);
        await EnhancedDeadCodeDetector.saveResults(codebasePath, orphanedExports);

        // Generate API reference (extracts endpoints from route files)
        progress.report({ message: 'Extracting API endpoints...' });
        const apiRefGenerator = new APIReferenceGenerator();
        await apiRefGenerator.generateAPIReference(
            workspaceFolder.uri.fsPath,
            files.map(f => path.relative(workspaceFolder.uri.fsPath, f)),
            models[0],
            progress
        );

        // Run Copilot QA on analysis results (if enabled)
        if (QualityAssuranceValidator.isEnabled(workspaceFolder.uri.fsPath)) {
            progress.report({ message: 'Running Copilot QA review...' });
            await this.runQualityAssurance(workspaceFolder.uri.fsPath, codebasePath, progress);
        }

        // Generate issues report
        progress.report({ message: 'Generating summary report...' });
        const reportPath = path.join(codebasePath, 'SUMMARY_REPORT.md');
        const report = issueTracker.generateReport();
        fs.writeFileSync(reportPath, report, 'utf-8');

        if (issueTracker.hasIssues()) {
            const issueCount = issueTracker.getIssues().length;
            vscode.window.showWarningMessage(
                `⚠️ Found ${issueCount} issue(s) during summarization. See SUMMARY_REPORT.md for details.`
            );
        }
    }

    /**
     * Regenerate only meta-analysis summaries (without re-summarizing files)
     * 
     * Rebuilds:
     * - complexity-heatmap.json
     * - component-map.json
     * - dead-code-analysis.json
     * - dependency-graph.json
     * - QA_REPORT.json
     */
    async regenerateMetaSummaries(
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }

        const codebasePath = path.join(workspaceFolder.uri.fsPath, '.codebase');
        
        // Verify summaries exist
        if (!fs.existsSync(codebasePath)) {
            throw new Error('No .codebase directory found. Run "LUNA: Generate Codebase Summaries" first.');
        }

        progress.report({ message: 'Analyzing existing summaries...' });
        
        // Get Language Model for API reference generation
        const modelSelector = this.getModelSelector();
        const models = await vscode.lm.selectChatModels(modelSelector);
        if (models.length === 0) {
            const modelName = modelSelector.id || modelSelector.family || 'unknown';
            throw new Error(`No language model "${modelName}" available. Please ensure the provider extension is installed and active.`);
        }

        // Discover files for API reference generation
        const files = await this.discoverFiles(workspaceFolder.uri.fsPath);

        // Rebuild directory index files so *.index.md / *.index.json are current
        progress.report({ message: 'Regenerating directory indices...' });
        const tree = DirectoryTreeBuilder.buildTree(workspaceFolder.uri.fsPath, files, []);
        const directories = DirectoryTreeBuilder.getDirectoriesBottomUp(tree);
        for (const dir of directories) {
            await this.generateDirectoryIndex(dir, workspaceFolder.uri.fsPath, tree);
        }
        await this.generateRootIndex(tree, workspaceFolder.uri.fsPath);

        // Regenerate analyses using existing file summaries
        progress.report({ message: 'Regenerating API reference...' });
        const apiRefGenerator = new APIReferenceGenerator();
        await apiRefGenerator.generateAPIReference(
            workspaceFolder.uri.fsPath,
            files.map(f => path.relative(workspaceFolder.uri.fsPath, f)),
            models[0],
            progress
        );

        progress.report({ message: 'Regenerating complexity heatmap...' });
        const dependencyAnalyzer = new DependencyAnalyzer();
        await dependencyAnalyzer.analyze(workspaceFolder.uri.fsPath);

        progress.report({ message: 'Regenerating dead code analysis...' });
        const deadCodeDetector = new EnhancedDeadCodeDetector();
        const orphanedExports = await deadCodeDetector.analyze(codebasePath, workspaceFolder.uri.fsPath);
        await EnhancedDeadCodeDetector.saveResults(codebasePath, orphanedExports);

        progress.report({ message: 'Regenerating dependency graph...' });
        // DependencyLinker runs after all analyses
        DependencyLinker.computeUsedByRelationships(workspaceFolder.uri.fsPath, codebasePath);

        // Run QA on regenerated analyses
        progress.report({ message: 'Running quality assurance validation...' });
        if (QualityAssuranceValidator.isEnabled(workspaceFolder.uri.fsPath)) {
            await this.runQualityAssurance(workspaceFolder.uri.fsPath, codebasePath, progress);
        }

        progress.report({ message: 'Meta-summaries regenerated! ✅' });
    }

    private async discoverFiles(workspacePath: string): Promise<string[]> {
        const files: string[] = [];
        const includeMatcher = new SummaryIncludeMatcher(workspacePath);
        
        // Get configured file type exclusions
        const config = vscode.workspace.getConfiguration('luna-encyclopedia');
        const excludePatterns = config.get<string[]>('fileTypesToExclude', [
            'd.ts', 'test.ts', 'spec.ts', 'test.js', 'spec.js', 'min.js', 'min.css'
        ]);
        
        // Walk directories specified in .lunasummarize (same approach as preview)
        const dirs = includeMatcher.getIncludeDirectories();
        console.log('[LUNA DEBUG] Include directories:', dirs);
        
        for (const dir of dirs) {
            const fullPath = path.join(workspacePath, dir);
            console.log('[LUNA DEBUG] Checking directory:', fullPath, 'Exists:', fs.existsSync(fullPath));
            if (fs.existsSync(fullPath)) {
                const beforeCount = files.length;
                this.walkDirectory(fullPath, workspacePath, includeMatcher, excludePatterns, files);
                console.log('[LUNA DEBUG] Added', files.length - beforeCount, 'files from', dir);
            }
        }

        // Also include explicit files
        const explicitFiles = includeMatcher.getIncludeFiles();
        for (const file of explicitFiles) {
            const fullPath = path.join(workspacePath, file);
            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                const fileName = path.basename(fullPath);
                let shouldExclude = false;
                for (const excludePattern of excludePatterns) {
                    if (fileName.endsWith(excludePattern)) {
                        shouldExclude = true;
                        break;
                    }
                }
                if (!shouldExclude && !includeMatcher.shouldExclude(fullPath, workspacePath)) {
                    files.push(fullPath);
                }
            }
        }

        console.log('[LUNA DEBUG] Total files discovered:', files.length);
        return [...new Set(files)].sort(); // Remove duplicates and sort
    }

    private walkDirectory(
        dirPath: string,
        workspacePath: string,
        includeMatcher: SummaryIncludeMatcher,
        excludePatterns: string[],
        results: string[]
    ): void {
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);

                if (entry.isDirectory()) {
                    // Skip common build/dependency directories
                    if (entry.name === 'node_modules' || entry.name === 'dist' || 
                        entry.name === 'build' || entry.name === 'out' ||
                        entry.name === '__pycache__' || entry.name.startsWith('.')) {
                        continue;
                    }
                    this.walkDirectory(fullPath, workspacePath, includeMatcher, excludePatterns, results);
                } else {
                    // Check if file should be included
                    if (includeMatcher.shouldInclude(fullPath, workspacePath)) {
                        if (!includeMatcher.shouldExclude(fullPath, workspacePath)) {
                            const fileName = path.basename(fullPath);
                            let shouldExclude = false;
                            for (const excludePattern of excludePatterns) {
                                if (fileName.endsWith(excludePattern)) {
                                    shouldExclude = true;
                                    break;
                                }
                            }
                            if (!shouldExclude) {
                                results.push(fullPath);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            // Silently skip directories we can't read
        }
    }

    /**
     * Split a large file into logical chunks at top-level function/class boundaries.
     * Each chunk includes the file header (imports, module-level declarations) as
     * shared context, followed by a group of top-level units whose total size fits
     * within maxChunkChars.
     *
     * If the file has no detectable top-level boundaries, returns a single chunk
     * with the full content so the caller can fall back to skeleton/truncation.
     */
    private splitFileIntoChunks(
        content: string,
        maxChunkChars: number = 12000
    ): Array<{ chunk: string; index: number; total: number }> {

        const lines = content.split('\n');

        // A "top-level boundary" is a line at column 0 that begins a new logical unit.
        // We match decorators separately so stacked decorators (@with_retry + @router.x)
        // stay with the function they decorate.
        const isTopLevelBoundary = (line: string): boolean => {
            if (line[0] === ' ' || line[0] === '\t') { return false; } // indented
            const t = line.trimStart();
            return (
                /^@[\w]/.test(t) ||                                         // decorator
                /^(async\s+)?def\s/.test(t) ||                              // Python def
                /^class\s/.test(t) ||                                       // Python/TS class
                /^(export\s+)?(default\s+)?(async\s+)?function[\s*]/.test(t) || // JS/TS function
                /^(export\s+)?(abstract\s+|default\s+)?class\s/.test(t) || // TS class
                /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?\(/.test(t) // arrow fn export
            );
        };

        // Collect header lines (everything before the first top-level boundary)
        let headerEnd = 0;
        for (let i = 0; i < lines.length; i++) {
            if (isTopLevelBoundary(lines[i])) { headerEnd = i; break; }
            if (i === lines.length - 1) { headerEnd = lines.length; } // no boundaries found
        }
        const headerText = lines.slice(0, headerEnd).join('\n');

        if (headerEnd === lines.length) {
            // No top-level boundaries — return as single chunk
            return [{ chunk: content, index: 0, total: 1 }];
        }

        // Group lines from headerEnd onward into top-level units.
        // A unit starts at a boundary line and ends just before the next boundary.
        const units: string[] = [];
        let unitStart = headerEnd;
        for (let i = headerEnd + 1; i <= lines.length; i++) {
            if (i === lines.length || isTopLevelBoundary(lines[i])) {
                units.push(lines.slice(unitStart, i).join('\n'));
                unitStart = i;
            }
        }

        if (units.length === 0) {
            return [{ chunk: content, index: 0, total: 1 }];
        }

        // Pack units into chunks that fit within maxChunkChars (accounting for header)
        const maxBody = maxChunkChars - headerText.length - 50;
        const groups: string[][] = [];
        let currentGroup: string[] = [];
        let currentSize = 0;

        for (const unit of units) {
            if (currentSize + unit.length > maxBody && currentGroup.length > 0) {
                groups.push(currentGroup);
                currentGroup = [];
                currentSize = 0;
            }
            currentGroup.push(unit);
            currentSize += unit.length;
        }
        if (currentGroup.length > 0) { groups.push(currentGroup); }

        if (groups.length <= 1) {
            // Everything fits in one chunk anyway
            return [{ chunk: content, index: 0, total: 1 }];
        }

        return groups.map((group, idx) => ({
            chunk: headerText + '\n\n' + group.join('\n'),
            index: idx,
            total: groups.length,
        }));
    }

    /**
     * Merge an array of partial FileSummary objects (from chunk passes) into one
     * coherent summary. Deduplicates keyComponents/publicAPI/codeLinks by name/signature.
     */
    private mergePartialSummaries(partials: FileSummary[]): FileSummary {
        if (partials.length === 0) { return this.createEmptyStructure(); }
        if (partials.length === 1) { return partials[0]; }

        const merged = this.createEmptyStructure();

        // Purpose: first non-empty value
        merged.purpose = partials.find(p => p.purpose?.trim())?.purpose ?? '';

        // keyComponents: union deduplicated by name
        const compSeen = new Set<string>();
        for (const p of partials) {
            for (const c of (p.keyComponents || [])) {
                if (c.name && !compSeen.has(c.name)) {
                    compSeen.add(c.name);
                    merged.keyComponents.push(c);
                }
            }
        }

        // publicAPI: union deduplicated by signature
        const apiSeen = new Set<string>();
        for (const p of partials) {
            for (const a of (p.publicAPI || [])) {
                const key = a.signature || a.description || '';
                if (key && !apiSeen.has(key)) {
                    apiSeen.add(key);
                    merged.publicAPI.push(a);
                }
            }
        }

        // codeLinks: union deduplicated by symbol
        const linkSeen = new Set<string>();
        for (const p of partials) {
            for (const l of (p.codeLinks || [])) {
                if (l.symbol && !linkSeen.has(l.symbol)) {
                    linkSeen.add(l.symbol);
                    merged.codeLinks.push(l);
                }
            }
        }

        // implementationNotes: join unique sentences/lines
        const noteSeen = new Set<string>();
        const noteLines: string[] = [];
        for (const p of partials) {
            for (const line of (p.implementationNotes || '').split('\n')) {
                const t = line.trim();
                if (t && !noteSeen.has(t)) {
                    noteSeen.add(t);
                    noteLines.push(line);
                }
            }
        }
        merged.implementationNotes = noteLines.join('\n');

        return merged;
    }

    /**
     * Generate a human-readable Markdown summary from a FileSummary JSON object.
     * Used when the summary was assembled from multiple chunk passes rather than
     * produced directly by the LLM as a single markdown block.
     */
    private generateMarkdownFromSummary(relPath: string, summary: FileSummary): string {
        const name = path.basename(relPath, path.extname(relPath));
        const lines: string[] = [`# ${name}`, ''];

        lines.push('## Purpose', '', summary.purpose || '(see implementation)', '');

        if (summary.keyComponents?.length) {
            lines.push('## Key Components', '');
            for (const c of summary.keyComponents) {
                const loc = c.lines ? ` (lines ${c.lines})` : '';
                lines.push(`- [\`${c.name}\`](${relPath}#L${c.lines?.split('-')[0] ?? ''})${loc}: ${c.description}`);
            }
            lines.push('');
        }

        if (summary.publicAPI?.length) {
            lines.push('## Public API', '');
            for (const a of summary.publicAPI) {
                const loc = a.lines ? ` (lines ${a.lines})` : '';
                lines.push(`- [\`${a.signature}\`](${relPath}#L${a.lines?.split('-')[0] ?? ''})${loc}`);
                lines.push(`  - **Description**: ${a.description}`);
            }
            lines.push('');
        }

        if (summary.codeLinks?.length) {
            lines.push('## Code Links', '');
            for (const l of summary.codeLinks) {
                lines.push(`- [${l.symbol}](${l.path})`);
            }
            lines.push('');
        }

        if (summary.implementationNotes?.trim()) {
            lines.push('## Implementation Notes', '', summary.implementationNotes, '');
        }

        return lines.join('\n');
    }

    private async analyzeSingleFile(
        filePath: string,
        workspacePath: string,
        model: vscode.LanguageModelChat
    ): Promise<void> {
        const content = fs.readFileSync(filePath, 'utf-8');
        const relPath = path.relative(workspacePath, filePath);
        const fileExt = path.extname(filePath);

        // Step 1: Extract imports using static analysis (100% reliable)
        const staticDeps = StaticImportAnalyzer.analyzeImports(content, relPath, workspacePath);

        const promptManager = PromptManager.getInstance();
        const SINGLE_PASS_LIMIT = 24000; // ~6k tokens — send verbatim if under this

        // Step 2a: Small file — single LLM call with full content
        if (content.length <= SINGLE_PASS_LIMIT) {
            const prompt = await promptManager.getPromptForFile('file-summary', filePath, {
                relativePath: relPath.replace(/\\/g, '/'),
                fileName: path.basename(relPath, fileExt),
                fileExtension: fileExt.substring(1) || 'txt',
                content,
            });
            const response = await model.sendRequest(
                [vscode.LanguageModelChatMessage.User(prompt)],
                { justification: 'Generating codebase summary for LUNA Encyclopedia' }
            );
            let fullResponse = '';
            for await (const part of response.text) { fullResponse += part; }
            const { markdown, json } = this.parseResponse(fullResponse, relPath);
            this.saveSummary(workspacePath, relPath, markdown, this.mergeDependencies(json, staticDeps));
            return;
        }

        // Step 2b: Large file — split into logical chunks and analyze each separately.
        // Multiple passes are more accurate than any truncation or skeleton approach.
        const chunks = this.splitFileIntoChunks(content, 12000);

        if (chunks.length <= 1) {
            // File didn't split at clean boundaries — send first SINGLE_PASS_LIMIT chars
            // with a note that it's truncated, so at least we get something reasonable.
            this.log(`[${relPath}] Large file (${Math.round(content.length / 1024)}KB) — no clean split boundaries, truncating`);
            const truncated = content.substring(0, SINGLE_PASS_LIMIT) + '\n# ...[file truncated for summary]';
            const prompt = await promptManager.getPromptForFile('file-summary', filePath, {
                relativePath: relPath.replace(/\\/g, '/'),
                fileName: path.basename(relPath, fileExt),
                fileExtension: fileExt.substring(1) || 'txt',
                content: truncated,
            });
            const response = await model.sendRequest(
                [vscode.LanguageModelChatMessage.User(prompt)],
                { justification: 'Generating codebase summary for LUNA Encyclopedia' }
            );
            let fullResponse = '';
            for await (const part of response.text) { fullResponse += part; }
            const { markdown, json } = this.parseResponse(fullResponse, relPath);
            this.saveSummary(workspacePath, relPath, markdown, this.mergeDependencies(json, staticDeps));
            return;
        }

        this.log(`[${relPath}] Large file (${Math.round(content.length / 1024)}KB) → ${chunks.length} chunks`);

        const partialSummaries: FileSummary[] = [];

        for (const { chunk, index, total } of chunks) {
            const annotatedContent =
                `[CHUNK ${index + 1}/${total} of ${relPath} — extract all components and public API visible in this excerpt]\n\n${chunk}`;

            const prompt = await promptManager.getPromptForFile('file-summary', filePath, {
                relativePath: relPath.replace(/\\/g, '/'),
                fileName: path.basename(relPath, fileExt),
                fileExtension: fileExt.substring(1) || 'txt',
                content: annotatedContent,
            });

            try {
                const response = await model.sendRequest(
                    [vscode.LanguageModelChatMessage.User(prompt)],
                    { justification: 'Generating codebase summary for LUNA Encyclopedia' }
                );
                let chunkResponse = '';
                for await (const part of response.text) { chunkResponse += part; }
                const { json } = this.parseResponse(chunkResponse, relPath);
                partialSummaries.push(json);
                this.log(`[${relPath}] Chunk ${index + 1}/${total}: ${json.keyComponents?.length ?? 0} components, ${json.publicAPI?.length ?? 0} API entries`);
            } catch (err) {
                this.log(`[${relPath}] Chunk ${index + 1}/${total} failed: ${err}`);
            }
        }

        if (partialSummaries.length === 0) {
            this.log(`[${relPath}] All chunks failed — saving empty summary`);
            this.saveSummary(workspacePath, relPath, `# ${path.basename(relPath)}\n\n(Analysis failed)`, this.mergeDependencies(this.createEmptyStructure(), staticDeps));
            return;
        }

        // Step 3: Merge partial summaries and save
        const mergedJson = this.mergeDependencies(this.mergePartialSummaries(partialSummaries), staticDeps);
        const markdown = this.generateMarkdownFromSummary(relPath, mergedJson);
        this.saveSummary(workspacePath, relPath, markdown, mergedJson);
    }
    
    private buildAnalysisPrompt(relPath: string, fileExt: string, content: string): string {
        const truncatedContent = content.length > 8000 ? content.substring(0, 8000) + '\n...[truncated]' : content;
        
        // Language-specific import guidance
        const languageHints = this.getLanguageHints(fileExt);
        
        // Load custom template if it exists
        const customTemplate = this.loadCustomTemplate();
        
        return `Analyze this source file and generate BOTH a Markdown summary AND a JSON structure.

**File**: \`${relPath}\`

**CRITICAL**: For EVERY component, function, class, and API, you MUST include line numbers where they appear. BUT:
- Only include line numbers if you are CERTAIN (90%+ confident)
- If unsure about exact lines, omit the "lines" field rather than guessing
- Use the format "lines": "123-168" for ranges or "lines": "42" for single lines
- For class definitions, include the ENTIRE class body range (from class keyword to last method)

**Note**: Dependencies (imports) will be automatically extracted via static analysis. Focus on providing rich insights about purpose, components, public API, and implementation details.

**Task**: Create a structured analysis optimized for AI agent consumption.

${languageHints}

**Output Format**: Return your response in TWO parts:

1. First, output JSON wrapped in \`\`\`json markers:
\`\`\`json
{
  "purpose": "One sentence describing what this file does",
  "keyComponents": [
    {"name": "ComponentName", "description": "What it does", "lines": "10-45"},
    {"name": "functionName", "description": "What it does", "lines": "50"}
  ],
  "dependencies": {
    "internal": [],
    "external": []
  },
  "publicAPI": [
    {
      "signature": "export function doThing(param: string): Promise<Result>",
      "description": "Description of what it does",
      "inputTypes": {"param": "string"},
      "returnType": "Promise<Result>",
      "lines": "100-120"
    }
  ],
  "codeLinks": [
    {"symbol": "main_function", "path": "${relPath}", "lines": "100-120"}
  ],
  "implementationNotes": "Important patterns, algorithms, or gotchas",
  "functionCalls": [
    {"function": "patch_get_output_data", "calledFrom": "process_node", "lines": "42-50"},
    {"function": "create_patch_unet_model__forward", "calledFrom": "initialize", "lines": "15-20"}
  ],
  "fileLevelMetadata": {
    "exportedItemCount": 5,
    "nodeCount": 1,
    "hasClasses": true,
    "hasFunctions": true,
    "complexity": "high/medium/low"
  }
}
\`\`\`

2. Then, output Markdown with proper working links:
\`\`\`markdown
# ${path.basename(relPath, path.extname(relPath))}

## Purpose
One concise paragraph.

## Key Components
- [\`ComponentName\`](${relPath.replace(/\\\\/g, '/')}#L10) (lines 10-45): Description
- [\`functionName()\`](${relPath.replace(/\\\\/g, '/')}#L50) (line 50): Description

## Public API
- [\`doThing(param: string): Promise<Result>\`](${relPath.replace(/\\\\/g, '/')}#L100) (lines 100-120)
  - **Input**: \`param: string\`
  - **Output**: \`Promise<Result>\`
  - **Description**: What the function does

## Code Links
- [main_function](${relPath.replace(/\\\\/g, '/')}#symbol=main_function)

## Implementation Notes
Important details.

## Function Calls
- \`patch_get_output_data()\` - Called from \`process_node()\` at lines 42-50
- \`create_patch_unet_model__forward()\` - Called from \`initialize()\` at lines 15-20
\`\`\`

**Source code**:
\`\`\`${fileExt.substring(1) || 'txt'}
${truncatedContent}
\`\`\`
${customTemplate}

**Important**: Be thorough in identifying:
1. EVERY function/class call made in this file (don't just mention "relies on utilities", list each one)
2. Structural metadata (number of exports, main components, overall complexity)

**DO NOT attempt to identify unused imports** - this will be detected via static analysis instead. Focus on SEMANTIC understanding of code purpose and relationships.`;
    }
    
    private getLanguageHints(fileExt: string): string {
        const ext = fileExt.toLowerCase();
        
        if (ext === '.py') {
            return `**Focus areas for Python files**:
- Document class hierarchies (parent classes, mixins) with line numbers (be conservative with ranges)
- For Pydantic models: List all field names and their types with line numbers
- Describe async functions and their role in the workflow
- Note any decorators and what they do
- **DETAILED FUNCTION CALLS**: List EVERY function/class that this file calls (e.g., "calls patch_get_output_data() at line 42, calls create_patch_unet_model__forward() at line 15")
- Explicitly state: number of classes, number of functions, overall complexity
- If file contains a single node/class: explicitly state "Contains only one X"
- For framework-specific patterns (decorators, magic methods): note that these are framework features, not unused code`;
        } else if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx') {
            return `**Focus areas for TypeScript/JavaScript files**:
- Document React component props and state (if applicable)
- Note any hooks usage (useState, useEffect, custom hooks)
- Describe exported functions, classes, and types
- **DETAILED FUNCTION CALLS**: List every imported function that is actually used (e.g., "calls useEffect at line 50, calls useState at line 45")
- Mention any important type definitions
- Count of exports and structural metadata
- Use line numbers conservatively - only when 100% confident`;
        } else if (ext === '.java' || ext === '.cs') {
            return `**Focus areas for ${ext === '.java' ? 'Java' : 'C#'} files**:
- Document class hierarchy and interfaces implemented
- List public methods with their signatures
- Note any annotations/attributes and their purpose
- Describe design patterns used
- List all method calls to external classes
- Use line numbers conservatively`;
        }
        
        return '';
    }
    
    private loadCustomTemplate(): string {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return '';
            }
            
            const codebasePath = path.join(workspaceFolders[0].uri.fsPath, '.codebase');
            const templatePath = path.join(codebasePath, '.luna-template.json');
            
            // Only load if template file exists
            if (!fs.existsSync(templatePath)) {
                return '';
            }
            
            const templateContent = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
            
            if (!templateContent.template || typeof templateContent.template !== 'object') {
                return '';
            }
            
            // Build custom fields section for the prompt
            let customPrompt = '\n**Custom Analysis Fields** (from .luna-template.json):\n';
            for (const [key, description] of Object.entries(templateContent.template)) {
                customPrompt += `- \`${key}\`: ${description}\n`;
            }
            
            customPrompt += '\nInclude these fields INSIDE the "summary" object of your JSON response using the same field names.\n';
            
            return customPrompt;
        } catch (error) {
            console.warn('Failed to load custom template:', error);
            return '';
        }
    }
    
    private parseResponse(response: string, relPath: string): { markdown: string; json: FileSummary } {
        // Extract JSON block
        const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
        let json: FileSummary;
        
        if (jsonMatch) {
            try {
                json = JSON.parse(jsonMatch[1].trim());
            } catch {
                // Fallback to empty structure
                json = this.createEmptyStructure();
            }
        } else {
            json = this.createEmptyStructure();
        }
        
        // Extract Markdown block
        const mdMatch = response.match(/```markdown\s*([\s\S]*?)```/);
        let markdown = mdMatch ? mdMatch[1].trim() : response;
        
        // If no markdown block found, use the whole response
        if (!mdMatch) {
            markdown = `# ${path.basename(relPath, path.extname(relPath))}\n\n${response}`;
        }
        
        return { markdown, json };
    }
    
    private createEmptyStructure(): FileSummary {
        return {
            purpose: '',
            keyComponents: [],
            dependencies: { internal: [], external: [] },
            publicAPI: [],
            codeLinks: [],
            implementationNotes: ''
        };
    }
    
    /**
     * Merge static analysis dependencies with Copilot's response
     * Static analysis takes precedence for accuracy
     */
    private mergeDependencies(copilotJson: FileSummary, staticDeps: { internal: any[]; external: any[] }): FileSummary {
        // Use static analysis for dependencies (100% reliable)
        // Keep Copilot's analysis for everything else (purpose, components, etc.)
        return {
            ...copilotJson,
            dependencies: {
                internal: staticDeps.internal.length > 0 ? staticDeps.internal : copilotJson.dependencies.internal,
                external: staticDeps.external.length > 0 ? staticDeps.external : copilotJson.dependencies.external
            }
        };
    }
    
    private saveSummary(
        workspacePath: string,
        relPath: string,
        markdown: string,
        json: FileSummary
    ): void {
        const config = vscode.workspace.getConfiguration('luna-encyclopedia');
        const branchAware = config.get<boolean>('branchAwareSummaries', false);
        const branchSuffix = GitBranchDetector.getBranchSuffix(workspacePath, branchAware);
        
        const codebasePath = path.join(workspacePath, '.codebase');
        const summaryPath = path.join(codebasePath, relPath);
        const summaryDir = path.dirname(summaryPath);
        
        // Create directory structure
        if (!fs.existsSync(summaryDir)) {
            fs.mkdirSync(summaryDir, { recursive: true });
        }
        
        // Get base filename without extension
        const baseWithoutExt = summaryPath.replace(/\.[^.]+$/, '');
        
        // Save Markdown with branch suffix
        const mdPath = `${baseWithoutExt}${branchSuffix}.md`;
        fs.writeFileSync(mdPath, markdown, 'utf-8');
        
        // Save JSON with branch suffix and metadata
        const jsonPath = `${baseWithoutExt}${branchSuffix}.json`;
        const metadata = {
            sourceFile: relPath,
            generatedAt: new Date().toISOString(),
            gitBranch: branchAware ? GitBranchDetector.getCurrentBranch(workspacePath) : null,
            summary: json
        };
        fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2), 'utf-8');
    }

    private async generateDirectoryIndex(
        dir: any,  // DirectoryNode
        workspacePath: string,
        tree: any  // DirectoryNode
    ): Promise<void> {
        const relativePath = path.relative(workspacePath, dir.path);
        const codebasePath = path.join(workspacePath, '.codebase');
        const dirName = dir.name;
        const indexPath = path.join(codebasePath, relativePath, `${dirName}.index.md`);
        const indexJsonPath = path.join(codebasePath, relativePath, `${dirName}.index.json`);

        // Build directory summary
        let indexContent = `# ${dirName}/\n\n## Overview\n\n`;
        
        // Prepare JSON structure
        const indexJson: any = {
            name: dirName,
            path: relativePath + '/',
            generated: new Date().toISOString(),
            fileCount: dir.files ? dir.files.length : 0,
            subdirCount: dir.subdirs ? dir.subdirs.length : 0,
            files: [],
            subdirectories: []
        };

        // List files in this directory
        if (dir.files && dir.files.length > 0) {
            indexContent += `### Files\n\n`;
            for (const filePath of dir.files.sort()) {
                const fileName = path.basename(filePath);
                const fileRelPath = path.relative(workspacePath, filePath);
                const summaryRelPath = path.relative(dir.path, filePath).replace(/\.[^.]+$/, '.md');
                
                // Try to read the file's summary for description
                const mdPath = path.join(codebasePath, fileRelPath.replace(/\.[^.]+$/, '.md'));
                let description = '(auto-generated summary)';
                
                if (fs.existsSync(mdPath)) {
                    const content = fs.readFileSync(mdPath, 'utf-8');
                    const purposeMatch = content.match(/## Purpose\n\n(.+?)(?:\n|$)/);
                    if (purposeMatch) {
                        description = purposeMatch[1];
                    }
                }

                indexContent += `- [${fileName}](${summaryRelPath}) — ${description}\n`;
                
                // Add to JSON
                indexJson.files.push({
                    name: fileName,
                    path: fileRelPath,
                    description: description
                });
            }
        }

        // List subdirectories
        if (dir.subdirs && dir.subdirs.length > 0) {
            indexContent += `\n### Subdirectories\n\n`;
            for (const subdir of dir.subdirs) {
                const subdirRelPath = path.relative(dir.path, subdir.path);
                indexContent += `- [${subdir.name}/](${subdirRelPath}/${subdir.name}.index.md) — (${subdir.files.length} files)\n`;
                
                // Add to JSON
                indexJson.subdirectories.push({
                    name: subdir.name,
                    path: path.join(relativePath, subdir.name) + '/',
                    fileCount: subdir.files.length,
                    subdirCount: subdir.subdirs ? subdir.subdirs.length : 0
                });
            }
        }

        const parentDirName = path.basename(path.dirname(dir.path)) || 'root';
        indexContent += `\n## Notes\n\nAuto-generated directory index. See [../${parentDirName}.index.md](../${parentDirName}.index.md) for parent directory.\n`;

        // Write index files
        const indexDir = path.dirname(indexPath);
        if (!fs.existsSync(indexDir)) {
            fs.mkdirSync(indexDir, { recursive: true });
        }
        fs.writeFileSync(indexPath, indexContent, 'utf-8');
        fs.writeFileSync(indexJsonPath, JSON.stringify(indexJson, null, 2), 'utf-8');
    }

    private async generateRootIndex(
        tree: any,  // DirectoryNode
        workspacePath: string
    ): Promise<void> {
        const codebasePath = path.join(workspacePath, '.codebase');
        const projectName = path.basename(workspacePath);
        const indexPath = path.join(codebasePath, `${projectName}.index.md`);
        const indexJsonPath = path.join(codebasePath, `${projectName}.index.json`);
        const timestamp = new Date().toISOString();

        let indexContent = `# Codebase Summaries Index\n\n`;
        indexContent += `**Project**: ${projectName}\n`;
        indexContent += `**Generated**: ${timestamp}\n\n`;

        indexContent += `## Structure\n\n`;
        
        // Prepare JSON structure
        const indexJson: any = {
            name: projectName,
            path: '',
            generated: timestamp,
            fileCount: 0,
            subdirCount: tree.subdirs ? tree.subdirs.length : 0,
            subdirectories: []
        };

        // List top-level subdirectories
        if (tree.subdirs && tree.subdirs.length > 0) {
            for (const subdir of tree.subdirs) {
                const fileCounts = `(${subdir.files.length} files`;
                const subCounts = subdir.subdirs.length > 0 ? `, ${subdir.subdirs.length} subdirs` : '';
                indexContent += `- [${subdir.name}/](${subdir.name}/${subdir.name}.index.md) ${fileCounts}${subCounts})\n`;
                
                indexJson.fileCount += subdir.files.length;
                indexJson.subdirectories.push({
                    name: subdir.name,
                    path: subdir.name + '/',
                    fileCount: subdir.files.length,
                    subdirCount: subdir.subdirs ? subdir.subdirs.length : 0
                });
            }
        }

        indexContent += `\n## Quick Navigation\n\n`;
        indexContent += `See individual \`foldername.index.md\` files in each directory for detailed file listings and descriptions.\n`;
        indexContent += `Start with [../USER_README.md](../USER_README.md) for project documentation.\n`;

        fs.writeFileSync(indexPath, indexContent, 'utf-8');
        fs.writeFileSync(indexJsonPath, JSON.stringify(indexJson, null, 2), 'utf-8');
    }

    async summarizeSingleFile(
        relPath: string,
        workspacePath: string,
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Check if Language Model API is available
        const modelSelector = this.getModelSelector();
        const models = await vscode.lm.selectChatModels(modelSelector);
        if (models.length === 0) {
            const modelName = modelSelector.id || modelSelector.family || 'unknown';
            throw new Error(`No language model "${modelName}" available. Please ensure the provider extension is installed and active.`);
        }

        // Resolve full file path
        const filePath = path.join(workspacePath, relPath);

        // Check if file exists
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${relPath}`);
        }

        progress.report({ message: `Analyzing ${path.basename(filePath)}...` });

        // Analyze the single file
        try {
            await this.analyzeSingleFile(filePath, workspacePath, models[0]);
            progress.report({ increment: 100 });
        } catch (error) {
            if (token.isCancellationRequested) {
                throw new Error('Summarization cancelled');
            }
            throw error;
        }
    }

    /**
     * Run Copilot QA on deterministic analysis results
     */
    private async runQualityAssurance(
        workspacePath: string,
        codebasePath: string,
        progress: vscode.Progress<{ message?: string; increment?: number }>
    ): Promise<void> {
        try {
            const qaValidator = new QualityAssuranceValidator();

            // Load analysis files
            const deadCodePath = path.join(codebasePath, 'dead-code-analysis.json');
            const complexityPath = path.join(codebasePath, 'complexity-heatmap.json');
            const componentPath = path.join(codebasePath, 'component-map.json');

            let deadCodeQA: any[] = [];
            let complexityQA: any[] = [];
            let componentQA: any = { verified: false, confidence: 0, issues: [], corrections: {} };

            // QA Dead Code Analysis
            if (fs.existsSync(deadCodePath)) {
                const deadCodeAnalysis = JSON.parse(fs.readFileSync(deadCodePath, 'utf-8'));
                if (deadCodeAnalysis.orphanedExports && deadCodeAnalysis.orphanedExports.length > 0) {
                    deadCodeQA = await qaValidator.validateDeadCode(deadCodeAnalysis, workspacePath, progress);
                    
                    // Update the analysis file with QA results
                    deadCodeAnalysis.qaReviewed = true;
                    deadCodeAnalysis.qaResults = deadCodeQA;
                    deadCodeAnalysis.falsePositives = deadCodeQA.filter(r => !r.verifiedUnused).length;
                    fs.writeFileSync(deadCodePath, JSON.stringify(deadCodeAnalysis, null, 2), 'utf-8');
                }
            }

            // QA Complexity Scores
            if (fs.existsSync(complexityPath)) {
                const complexityHeatmap = JSON.parse(fs.readFileSync(complexityPath, 'utf-8'));
                complexityQA = await qaValidator.validateComplexity(complexityHeatmap, workspacePath, progress);
                
                // Update the analysis file with QA results
                complexityHeatmap.qaReviewed = true;
                complexityHeatmap.qaResults = complexityQA;
                fs.writeFileSync(complexityPath, JSON.stringify(complexityHeatmap, null, 2), 'utf-8');
            }

            // QA Component Categorization
            if (fs.existsSync(componentPath)) {
                const componentMap = JSON.parse(fs.readFileSync(componentPath, 'utf-8'));
                componentQA = await qaValidator.validateComponentMap(componentMap, workspacePath, progress);
                
                // Update the analysis file with QA results
                componentMap.qaReviewed = true;
                componentMap.qaResult = componentQA;
                fs.writeFileSync(componentPath, JSON.stringify(componentMap, null, 2), 'utf-8');
            }

            // Write consolidated QA report
            QualityAssuranceValidator.writeQAReport(workspacePath, deadCodeQA, complexityQA, componentQA);

            // Show summary
            const falsePositives = deadCodeQA.filter(r => !r.verifiedUnused).length;
            const adjustments = complexityQA.filter(r => r.originalScore !== r.adjustedScore).length;
            
            if (falsePositives > 0 || adjustments > 0) {
                vscode.window.showInformationMessage(
                    `🔍 QA Review: Found ${falsePositives} false positive dead code alerts, ${adjustments} complexity adjustments. See QA_REPORT.json for details.`
                );
            }
        } catch (error) {
            console.error('QA validation failed:', error);
            // Non-fatal - continue with the rest of the process
        }
    }
}
