import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PromptManager } from './promptManager';
import { requireConfiguredChatModel } from './modelSelection';

type VerbosityLevel = 'beginner' | 'intermediate' | 'expert';

interface CodeSection {
    name: string;
    type: 'imports' | 'class' | 'function' | 'constant' | 'other';
    startLine: number;
    endLine: number;
    code: string;
}

interface BreakdownChunk {
    sectionName: string;
    lineRange: string;
    content: string;
}

export class CodeBreakdownGenerator {
    private model: vscode.LanguageModelChat | null = null;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * Get the verbosity level from settings
     */
    private getVerbosityLevel(): VerbosityLevel {
        const config = vscode.workspace.getConfiguration('luna-encyclopedia');
        return config.get<VerbosityLevel>('breakdownVerbosity', 'intermediate');
    }

    /**
     * Initialize the configured language model
     */
    private async ensureModel(): Promise<vscode.LanguageModelChat | null> {
        if (this.model) {
            return this.model;
        }

        this.model = await requireConfiguredChatModel();

        return this.model;
    }

    /**
     * Generate a code breakdown for a file
     */
    async generateBreakdown(
        filePath: string,
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ): Promise<string> {
        const model = await this.ensureModel();
        if (!model) {
            throw new Error('No language model available');
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const fileName = path.basename(filePath);
        const fileExt = path.extname(filePath);
        const lines = content.split('\n');
        const verbosity = this.getVerbosityLevel();

        // Agent 1: Analyze structure
        progress.report({ message: '🔍 Analyzing code structure...' });
        const sections = await this.analyzeStructure(model, content, fileName, fileExt, filePath, token);
        
        if (token.isCancellationRequested) {
            throw new Error('Cancelled by user');
        }

        // Determine chunking strategy
        const chunks = this.createChunks(sections, lines);
        const totalChunks = chunks.length;

        // Agent 2: Generate explanations for each chunk
        const explanations: BreakdownChunk[] = [];
        for (let i = 0; i < chunks.length; i++) {
            if (token.isCancellationRequested) {
                throw new Error('Cancelled by user');
            }

            progress.report({ 
                message: `📝 Generating explanations (${i + 1}/${totalChunks})...`,
                increment: (50 / totalChunks)
            });

            const chunk = chunks[i];
            const explanation = await this.explainSection(
                model, 
                chunk, 
                verbosity, 
                fileName, 
                fileExt,
                filePath,
                token
            );
            
            explanations.push({
                sectionName: chunk.name,
                lineRange: `${chunk.startLine}-${chunk.endLine}`,
                content: explanation
            });
        }

        // Agent 3: Validate accuracy (for non-expert levels)
        if (verbosity !== 'expert' && !token.isCancellationRequested) {
            progress.report({ message: '✅ Validating accuracy...' });
            await this.validateExplanations(model, explanations, content, token);
        }

        // Agent 4: Stitch together
        progress.report({ message: '📋 Creating breakdown document...' });
        const finalDocument = this.stitchDocument(fileName, filePath, verbosity, explanations, lines.length);

        return finalDocument;
    }

    /**
     * Agent 1: Analyze the structure of the code
     */
    private async analyzeStructure(
        model: vscode.LanguageModelChat,
        content: string,
        fileName: string,
        fileExt: string,
        filePath: string,
        token: vscode.CancellationToken
    ): Promise<CodeSection[]> {
        const truncated = content.length > 15000 ? content.substring(0, 15000) + '\n...[truncated]' : content;

        const promptManager = PromptManager.getInstance();
        const prompt = await promptManager.getPromptForFile('structure-analysis', filePath, {
            fileName,
            fileExtension: fileExt.substring(1) || 'txt',
            content: truncated
        });

        try {
            const messages = [vscode.LanguageModelChatMessage.User(prompt)];
            const response = await model.sendRequest(messages, {});
            
            let responseText = '';
            for await (const chunk of response.text) {
                if (token.isCancellationRequested) break;
                responseText += chunk;
            }

            const jsonMatch = responseText.match(/```json\s*([\s\S]*?)```/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[1]);
            }
        } catch (error) {
            console.error('Structure analysis failed:', error);
        }

        // Fallback: treat entire file as one section
        const lines = content.split('\n');
        return [{
            name: 'Full File',
            type: 'other',
            startLine: 1,
            endLine: lines.length,
            code: content
        }];
    }

    /**
     * Create chunks from sections (max ~300 lines per chunk)
     */
    private createChunks(sections: CodeSection[], lines: string[]): CodeSection[] {
        const chunks: CodeSection[] = [];
        const MAX_LINES_PER_CHUNK = 300;

        for (const section of sections) {
            const sectionLines = section.endLine - section.startLine + 1;
            
            if (sectionLines <= MAX_LINES_PER_CHUNK) {
                // Section fits in one chunk
                const code = lines.slice(section.startLine - 1, section.endLine).join('\n');
                chunks.push({ ...section, code });
            } else {
                // Split section into multiple chunks
                let currentStart = section.startLine;
                let partNum = 1;
                
                while (currentStart <= section.endLine) {
                    const currentEnd = Math.min(currentStart + MAX_LINES_PER_CHUNK - 1, section.endLine);
                    const code = lines.slice(currentStart - 1, currentEnd).join('\n');
                    
                    chunks.push({
                        name: `${section.name} (Part ${partNum})`,
                        type: section.type,
                        startLine: currentStart,
                        endLine: currentEnd,
                        code
                    });
                    
                    currentStart = currentEnd + 1;
                    partNum++;
                }
            }
        }

        return chunks;
    }

    /**
     * Agent 2: Explain a section of code
     */
    private async explainSection(
        model: vscode.LanguageModelChat,
        section: CodeSection,
        verbosity: VerbosityLevel,
        fileName: string,
        fileExt: string,
        filePath: string,
        token: vscode.CancellationToken
    ): Promise<string> {
        const verbosityInstructions = this.getVerbosityInstructions(verbosity);

        const promptManager = PromptManager.getInstance();
        const prompt = await promptManager.getPromptForFile('section-explanation', filePath, {
            sectionType: section.type,
            fileName,
            verbosity: verbosity.toUpperCase(),
            verbosityInstructions,
            sectionName: section.name,
            startLine: section.startLine,
            endLine: section.endLine,
            fileExtension: fileExt.substring(1) || 'txt',
            content: section.code
        });

        try {
            const messages = [vscode.LanguageModelChatMessage.User(prompt)];
            const response = await model.sendRequest(messages, {});
            
            let responseText = '';
            for await (const chunk of response.text) {
                if (token.isCancellationRequested) break;
                responseText += chunk;
            }

            return responseText;
        } catch (error) {
            console.error(`Failed to explain section ${section.name}:`, error);
            return `*Failed to generate explanation for ${section.name}*`;
        }
    }

    /**
     * Get verbosity-specific instructions
     */
    private getVerbosityInstructions(verbosity: VerbosityLevel): string {
        switch (verbosity) {
            case 'beginner':
                return `**BEGINNER MODE - Maximum Detail**

Structure your explanation as:

1. **Full Code Block** - Show the complete code again with line numbers
2. **Line-by-Line Breakdown** - Explain EVERY line in plain English
   - What the line does
   - What each keyword/symbol means
   - Why it's there
3. **Real-World Analogy** - Compare to something non-technical
4. **Visual Diagram** - Use ASCII art or mermaid diagram if helpful
5. **What Could Go Wrong** - Common mistakes beginners make here
6. **Try It Yourself** - A small exercise to practice this concept

Use simple language. Define jargon. Assume they're learning the language itself.
Be encouraging and thorough. More is better.`;

            case 'intermediate':
                return `**INTERMEDIATE MODE - Balanced Explanation**

Structure your explanation as:

1. **Purpose** - One-sentence summary of what this section does
2. **Key Code Snippet** - Show the most important parts (not everything)
3. **How It Works** - Step-by-step explanation of the logic flow
4. **Important Patterns** - Any design patterns, idioms, or conventions used
5. **Gotchas** - Edge cases or tricky bits to watch for

Assume they know the language basics but are new to this codebase.
Focus on the "why" and project-specific patterns.`;

            case 'expert':
                return `**EXPERT MODE - Architecture & Gotchas Only**

Structure your explanation as:

1. **Design Decision** - Why this approach vs alternatives (one line)
2. **Key Sections** - Bullet list of what's where (line numbers)
3. **Tricky Bits** - Only the non-obvious, complex parts
4. **Performance/Security Notes** - If relevant

Be concise. Skip obvious things. Focus on what a senior dev would find useful for quick onboarding.
Maximum 10 lines per section.`;
        }
    }

    /**
     * Agent 3: Validate explanations for accuracy
     */
    private async validateExplanations(
        model: vscode.LanguageModelChat,
        explanations: BreakdownChunk[],
        originalCode: string,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Sample validation - check a random explanation for accuracy
        if (explanations.length === 0) return;

        const sampleIndex = Math.floor(Math.random() * explanations.length);
        const sample = explanations[sampleIndex];

        const prompt = `You are a code review validator. Check if this explanation is accurate.

**Explanation to validate:**
${sample.content.substring(0, 2000)}

**Original code (relevant section):**
\`\`\`
${originalCode.substring(0, 3000)}
\`\`\`

Check for:
1. Factual errors about what the code does
2. Misleading explanations
3. Important missing information

If there are issues, note them briefly. If accurate, say "VALID".`;

        try {
            const messages = [vscode.LanguageModelChatMessage.User(prompt)];
            const response = await model.sendRequest(messages, {});
            
            let responseText = '';
            for await (const chunk of response.text) {
                if (token.isCancellationRequested) break;
                responseText += chunk;
            }

            // Log validation result (could add corrections in future)
            if (!responseText.includes('VALID')) {
                console.warn('Validation found potential issues:', responseText.substring(0, 200));
            }
        } catch (error) {
            console.error('Validation failed:', error);
        }
    }

    /**
     * Agent 4: Stitch all explanations into final document
     */
    private stitchDocument(
        fileName: string,
        filePath: string,
        verbosity: VerbosityLevel,
        explanations: BreakdownChunk[],
        totalLines: number
    ): string {
        const verbosityLabel = {
            'beginner': '📚 Beginner (Full Explanations)',
            'intermediate': '📖 Intermediate (Balanced)',
            'expert': '⚡ Expert (Quick Overview)'
        };

        let doc = `# ${fileName} - Code Breakdown

> **Generated by LUNA Encyclopedia**  
> **Verbosity Level:** ${verbosityLabel[verbosity]}  
> **Total Lines:** ${totalLines}  
> **Generated:** ${new Date().toLocaleString()}

---

## Table of Contents

${explanations.map((e, i) => `${i + 1}. [${e.sectionName}](#${this.slugify(e.sectionName)}) (Lines ${e.lineRange})`).join('\n')}

---

`;

        for (const explanation of explanations) {
            doc += `## ${explanation.sectionName}

*Lines ${explanation.lineRange}*

${explanation.content}

---

`;
        }

        doc += `
## Need More Help?

- 📖 See the [summary file](${path.basename(filePath).replace(/\.[^.]+$/, '.md')}) for a quick reference
- 💬 Ask Copilot: "Explain the ${fileName} file in more detail"
- 🔍 Use "Go to Definition" to explore dependencies

*This breakdown was generated with love by LUNA Encyclopedia 🌙*
`;

        return doc;
    }

    /**
     * Create URL-safe slug for TOC links
     */
    private slugify(text: string): string {
        return text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
    }

    /**
     * Save breakdown to file
     */
    async saveBreakdown(filePath: string, content: string): Promise<string> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder open');
        }

        const workspacePath = workspaceFolder.uri.fsPath;
        const codebasePath = path.join(workspacePath, '.codebase');
        
        // Get relative path and create directory structure
        const relPath = path.relative(workspacePath, filePath);
        const relDir = path.dirname(relPath);
        const baseName = path.basename(filePath, path.extname(filePath));
        
        const breakdownDir = path.join(codebasePath, relDir);
        if (!fs.existsSync(breakdownDir)) {
            fs.mkdirSync(breakdownDir, { recursive: true });
        }

        const breakdownPath = path.join(breakdownDir, `${baseName}.breakdown.md`);
        fs.writeFileSync(breakdownPath, content, 'utf-8');

        return breakdownPath;
    }
}
