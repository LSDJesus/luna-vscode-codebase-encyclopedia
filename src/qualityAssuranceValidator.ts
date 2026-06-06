import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PromptManager } from './promptManager';
import { requireConfiguredChatModel } from './modelSelection';

interface QAResult {
    verified: boolean;
    confidence: number;
    issues: string[];
    corrections: Record<string, any>;
}

interface DeadCodeQAResult {
    export: string;
    file: string;
    flaggedAsDead: boolean;
    verifiedUnused: boolean;
    reason: string;
    confidence: number;
}

interface ComplexityQAResult {
    file: string;
    originalScore: number;
    adjustedScore: number;
    reason: string;
    confidence: number;
}

interface StalenessQAResult {
    file: string;
    requiresResummarization: boolean;
    reason: string;
    changeType: 'semantic' | 'syntactic' | 'formatting';
}

export class QualityAssuranceValidator {
    private model: vscode.LanguageModelChat | null = null;

    constructor() {}

    /**
     * Check if AI QA is enabled (from VS Code settings only)
     */
    static isEnabled(workspacePath: string): boolean {
        // Check VS Code global setting
        const config = vscode.workspace.getConfiguration('luna-encyclopedia');
        return config.get<boolean>('enableCopilotQA', true);
    }

    /**
     * Initialize the configured language model for QA
     */
    private async ensureModel(): Promise<vscode.LanguageModelChat | null> {
        if (this.model) {
            return this.model;
        }

        this.model = await requireConfiguredChatModel();

        return this.model;
    }

    /**
     * QA for Dead Code Analysis - Verify if exports are truly unused
     */
    async validateDeadCode(
        deadCodeAnalysis: any,
        workspacePath: string,
        progress?: vscode.Progress<{ message?: string }>
    ): Promise<DeadCodeQAResult[]> {
        const model = await this.ensureModel();
        if (!model) {
            console.warn('No language model available for QA');
            return [];
        }

        const results: DeadCodeQAResult[] = [];
        const orphanedExports = deadCodeAnalysis.orphanedExports || [];

        // Batch process to reduce API calls (groups of 5)
        const batchSize = 5;
        for (let i = 0; i < orphanedExports.length; i += batchSize) {
            const batch = orphanedExports.slice(i, i + batchSize);
            
            progress?.report({ 
                message: `QA: Validating dead code (${i + 1}-${Math.min(i + batchSize, orphanedExports.length)}/${orphanedExports.length})...` 
            });

            const promptManager = PromptManager.getInstance();
            const prompt = await promptManager.getQAPrompt('dead-code', {
                exportsJSON: JSON.stringify(batch, null, 2),
                workspaceName: path.basename(workspacePath)
            });

            try {
                const messages = [vscode.LanguageModelChatMessage.User(prompt)];
                const response = await model.sendRequest(messages, {});
                
                let responseText = '';
                for await (const chunk of response.text) {
                    responseText += chunk;
                }

                // Extract JSON from response
                const jsonMatch = responseText.match(/```json\s*([\s\S]*?)```/);
                if (jsonMatch) {
                    const qaResults = JSON.parse(jsonMatch[1]);
                    for (const result of qaResults) {
                        results.push({
                            export: result.export,
                            file: result.file,
                            flaggedAsDead: true,
                            verifiedUnused: result.verifiedUnused,
                            reason: result.reason,
                            confidence: result.confidence
                        });
                    }
                }
            } catch (error) {
                console.error('Dead code QA failed for batch:', error);
            }
        }

        return results;
    }

    /**
     * QA for Complexity Scores - Validate if scores match actual code patterns
     */
    async validateComplexity(
        complexityHeatmap: any,
        workspacePath: string,
        progress?: vscode.Progress<{ message?: string }>
    ): Promise<ComplexityQAResult[]> {
        const model = await this.ensureModel();
        if (!model) {
            return [];
        }

        const results: ComplexityQAResult[] = [];
        const highComplexityFiles = (complexityHeatmap.complexity || [])
            .filter((c: any) => c.totalScore >= 6);

        // Sample top 10 for QA (to limit API calls)
        const filesToCheck = highComplexityFiles.slice(0, 10);

        progress?.report({ 
            message: `QA: Validating complexity scores (${filesToCheck.length} files)...` 
        });

        for (const fileData of filesToCheck) {
            const filePath = path.join(workspacePath, fileData.file);
            if (!fs.existsSync(filePath)) continue;

            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const truncated = content.length > 3000 ? content.substring(0, 3000) + '\n...[truncated]' : content;

                const promptManager = PromptManager.getInstance();
                const prompt = await promptManager.getQAPrompt('complexity', {
                    file: fileData.file,
                    coupling: fileData.coupling,
                    impact: fileData.impact,
                    volatility: fileData.volatility,
                    totalScore: fileData.totalScore,
                    recommendation: fileData.recommendation,
                    content: truncated
                });

                const messages = [vscode.LanguageModelChatMessage.User(prompt)];
                const response = await model.sendRequest(messages, {});
                
                let responseText = '';
                for await (const chunk of response.text) {
                    responseText += chunk;
                }

                const jsonMatch = responseText.match(/```json\s*([\s\S]*?)```/);
                if (jsonMatch) {
                    const qaResult = JSON.parse(jsonMatch[1]);
                    results.push({
                        file: fileData.file,
                        originalScore: fileData.totalScore,
                        adjustedScore: qaResult.adjustedScore,
                        reason: qaResult.reason,
                        confidence: qaResult.confidence
                    });
                }
            } catch (error) {
                console.error(`Complexity QA failed for ${fileData.file}:`, error);
            }
        }

        return results;
    }

    /**
     * QA for Staleness Detection - Determine if change requires re-summarization
     */
    async validateStaleness(
        changedFiles: { filePath: string; oldContent: string; newContent: string }[],
        progress?: vscode.Progress<{ message?: string }>
    ): Promise<StalenessQAResult[]> {
        const model = await this.ensureModel();
        if (!model) {
            return [];
        }

        const results: StalenessQAResult[] = [];

        // Batch process
        const batchSize = 3;
        for (let i = 0; i < changedFiles.length; i += batchSize) {
            const batch = changedFiles.slice(i, i + batchSize);
            
            progress?.report({ 
                message: `QA: Analyzing change semantics (${i + 1}-${Math.min(i + batchSize, changedFiles.length)}/${changedFiles.length})...` 
            });

            for (const file of batch) {
                try {
                    // Create a diff summary (simplified)
                    const oldLines = file.oldContent.split('\n').length;
                    const newLines = file.newContent.split('\n').length;
                    const lineDiff = Math.abs(newLines - oldLines);

                    const promptManager = PromptManager.getInstance();
                    const prompt = await promptManager.getQAPrompt('staleness', {
                        filePath: file.filePath,
                        lineDiff,
                        oldContent: file.oldContent.substring(0, 1000),
                        newContent: file.newContent.substring(0, 1000)
                    });

                    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
                    const response = await model.sendRequest(messages, {});
                    
                    let responseText = '';
                    for await (const chunk of response.text) {
                        responseText += chunk;
                    }

                    const jsonMatch = responseText.match(/```json\s*([\s\S]*?)```/);
                    if (jsonMatch) {
                        const qaResult = JSON.parse(jsonMatch[1]);
                        results.push({
                            file: file.filePath,
                            requiresResummarization: qaResult.requiresResummarization,
                            reason: qaResult.reason,
                            changeType: qaResult.changeType
                        });
                    }
                } catch (error) {
                    console.error(`Staleness QA failed for ${file.filePath}:`, error);
                }
            }
        }

        return results;
    }

    /**
     * QA for Component Categorization - Validate file groupings make sense
     */
    async validateComponentMap(
        componentMap: any,
        workspacePath: string,
        progress?: vscode.Progress<{ message?: string }>
    ): Promise<QAResult> {
        const model = await this.ensureModel();
        if (!model) {
            return { verified: false, confidence: 0, issues: ['No language model available'], corrections: {} };
        }

        progress?.report({ message: 'QA: Validating component categorization...' });

        const promptManager = PromptManager.getInstance();
        const prompt = await promptManager.getQAPrompt('component', {
            workspaceName: path.basename(workspacePath),
            componentsJSON: JSON.stringify(componentMap.components, null, 2)
        });

        try {
            const messages = [vscode.LanguageModelChatMessage.User(prompt)];
            const response = await model.sendRequest(messages, {});
            
            let responseText = '';
            for await (const chunk of response.text) {
                responseText += chunk;
            }

            const jsonMatch = responseText.match(/```json\s*([\s\S]*?)```/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[1]);
            }
        } catch (error) {
            console.error('Component map QA failed:', error);
        }

        return { verified: false, confidence: 0, issues: ['QA check failed'], corrections: {} };
    }

    /**
     * Write QA results to a separate file for transparency
     */
    static writeQAReport(
        workspacePath: string,
        deadCodeQA: DeadCodeQAResult[],
        complexityQA: ComplexityQAResult[],
        componentQA: QAResult
    ): void {
        const codebasePath = path.join(workspacePath, '.codebase');
        const reportPath = path.join(codebasePath, 'QA_REPORT.json');

        const report = {
            generated: new Date().toISOString(),
            enabled: true,
            deadCodeAnalysis: {
                reviewed: deadCodeQA.length,
                falsePositives: deadCodeQA.filter(r => !r.verifiedUnused).length,
                results: deadCodeQA
            },
            complexityAnalysis: {
                reviewed: complexityQA.length,
                adjustments: complexityQA.filter(r => r.originalScore !== r.adjustedScore).length,
                results: complexityQA
            },
            componentCategorization: componentQA
        };

        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    }
}
