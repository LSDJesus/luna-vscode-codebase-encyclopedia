import * as vscode from 'vscode';

const CONFIG_SECTION = 'luna-encyclopedia';

export interface LunaModelSelection {
    selector: vscode.LanguageModelChatSelector;
    vendor?: string;
    family?: string;
    id?: string;
    label: string;
}

function cleanSetting(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

export function getConfiguredModelSelection(
    config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(CONFIG_SECTION)
): LunaModelSelection {
    const vendor = cleanSetting(config.get<string>('modelVendor', 'copilot'));
    const family = cleanSetting(config.get<string>('copilotModel', 'gpt-4o'));
    const id = cleanSetting(config.get<string>('modelId', ''));

    const selector: vscode.LanguageModelChatSelector = {};
    if (vendor) {
        selector.vendor = vendor;
    }

    if (id) {
        selector.id = id;
    } else if (family) {
        selector.family = family;
    }

    const label = id
        ? `${vendor || 'any vendor'} / ${id}`
        : `${vendor || 'any vendor'} / ${family || 'default'}`;

    return {
        selector,
        vendor,
        family,
        id,
        label
    };
}

export async function selectConfiguredChatModels(
    config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(CONFIG_SECTION)
): Promise<vscode.LanguageModelChat[]> {
    return vscode.lm.selectChatModels(getConfiguredModelSelection(config).selector);
}

export async function requireConfiguredChatModel(
    config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(CONFIG_SECTION)
): Promise<vscode.LanguageModelChat> {
    const selection = getConfiguredModelSelection(config);
    const models = await vscode.lm.selectChatModels(selection.selector);

    if (models.length === 0) {
        throw new Error(
            `No language model available for "${selection.label}". Use "LUNA: Select Summary Model" or update the LUNA model settings.`
        );
    }

    return models[0];
}

export async function listAvailableChatModels(vendor?: string): Promise<vscode.LanguageModelChat[]> {
    const cleanVendor = cleanSetting(vendor);
    const selector = cleanVendor ? { vendor: cleanVendor } : undefined;
    const models = await vscode.lm.selectChatModels(selector);

    return [...models].sort((left, right) => {
        const vendorCompare = left.vendor.localeCompare(right.vendor);
        if (vendorCompare !== 0) {
            return vendorCompare;
        }

        const familyCompare = left.family.localeCompare(right.family);
        if (familyCompare !== 0) {
            return familyCompare;
        }

        return left.name.localeCompare(right.name);
    });
}

export async function saveSelectedChatModel(
    model: vscode.LanguageModelChat,
    target: vscode.ConfigurationTarget = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global
): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

    await config.update('modelVendor', model.vendor, target);
    await config.update('modelId', model.id, target);
    await config.update('copilotModel', model.family, target);
}

export function formatLanguageModel(model: vscode.LanguageModelChat): string {
    return `${model.vendor} / ${model.name} (${model.id})`;
}