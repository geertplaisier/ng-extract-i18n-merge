import {BuilderContext, BuilderOutput, createBuilder} from '@angular-devkit/architect';
import {basename, dirname, join, JsonObject, normalize} from '@angular-devkit/core';
import {mergeWithMapping} from 'xliff-simple-merge/dist/src/merge';
import {promises as fs} from 'fs';
import {xmlNormalize} from 'xml_normalize/dist/src/xmlNormalize';
import {XmlDocument, XmlElement} from 'xmldoc';
import {Evaluator} from 'xml_normalize/dist/src/xpath/simpleXPath';
import {readFileIfExists} from './fileUtils';

export interface Options extends JsonObject {
    format: 'xlf' | 'xlif' | 'xliff' | 'xlf2' | 'xliff2' | null
    outputPath: string | null,
    sourceFile: string | null,
    targetFiles: string[],
    sourceLanguageTargetFile: string | null,
    removeIdsWithPrefix: string[] | null,
    fuzzyMatch: boolean,
    resetTranslationState: boolean,
    collapseWhitespace: boolean,
    trim: boolean,
    includeContext: boolean | 'sourceFileOnly',
    newTranslationTargetsBlank: boolean | 'omit',
    sort: 'idAsc' | 'stableAppendNew',
    browserTarget: string,
    verbose: boolean
}

export default createBuilder(extractI18nMergeBuilder);

function resetSortOrder(originalTranslationSourceFile: string, updatedTranslationSourceFile: string, idPath: string, idMapping: { [oldId: string]: string }, options: Options): string {
    const originalDocEval = new Evaluator(new XmlDocument(originalTranslationSourceFile));
    const originalIdsOrder = originalDocEval.evalValues(idPath).map(id => idMapping[id] ?? id);

    const updatedTranslationSourceDoc = new XmlDocument(updatedTranslationSourceFile);
    const translationUnitsParentPath = idPath.replace(new RegExp('/[^/]*/@id$'), '');
    const translationUnitsParent = new Evaluator(updatedTranslationSourceDoc).evalNodeSet(translationUnitsParentPath)[0];

    translationUnitsParent.children = translationUnitsParent.children
        .filter((n): n is XmlElement => n.type === 'element') // filter out text (white space)
        .sort((a, b) => {
            const indexA = originalIdsOrder.indexOf(a.attr.id);
            const indexB = originalIdsOrder.indexOf(b.attr.id);
            if (indexA === -1 && indexB === -1) {
                return a.attr.id.toLowerCase().localeCompare(b.attr.id.toLowerCase());
            } else if (indexA === -1) {
                return 1;
            } else if (indexB === -1) {
                return -1;
            } else {
                return indexA - indexB;
            }
        });
    translationUnitsParent.firstChild = translationUnitsParent.children[0];
    translationUnitsParent.lastChild = translationUnitsParent.children[translationUnitsParent.children.length - 1];

    // retain xml declaration:
    const xmlDecMatch = updatedTranslationSourceFile.match(/^<\?xml [^>]*>\s*/i);
    const xmlDeclaration = xmlDecMatch ? xmlDecMatch[0] : '';

    // we need to reformat the xml (whitespaces are messed up by the sort):
    return xmlNormalize({
        in: xmlDeclaration + updatedTranslationSourceDoc.toString({preserveWhitespace: true, compressed: true}),
        trim: options.trim ?? false,
        normalizeWhitespace: options.collapseWhitespace ?? true
    });
}

async function extractI18nMergeBuilder(options: Options, context: BuilderContext): Promise<BuilderOutput> {
    context.logger.info(`Running ng-extract-i18n-merge for project ${context.target?.project}`);

    if (!options.verbose) {
        console.debug = () => null; // prevent debug output from xml_normalize and xliff-simple-merge
    }
    context.logger.debug(`options: ${JSON.stringify(options)}`);
    const outputPath = options.outputPath as string || '.';
    const format = options.format as string || 'xlf';
    const isXliffV2 = format.includes('2');

    context.logger.info('running "extract-i18n" ...');
    const sourcePath = join(normalize(outputPath), options.sourceFile ?? 'messages.xlf');
    const translationSourceFileOriginal = await readFileIfExists(sourcePath);

    const extractI18nRun = await context.scheduleBuilder('@angular-devkit/build-angular:extract-i18n', {
        browserTarget: options.browserTarget,
        outputPath: dirname(sourcePath),
        outFile: basename(sourcePath),
        format,
        progress: false
    }, {target: context.target, logger: context.logger.createChild('extract-i18n')});
    const extractI18nResult = await extractI18nRun.result;
    if (!extractI18nResult.success) {
        return {success: false, error: `"extract-i18n" failed: ${extractI18nResult.error}`};
    }
    context.logger.info(`extracted translations successfully`);

    context.logger.info(`normalize ${sourcePath} ...`);
    const translationSourceFile = await fs.readFile(sourcePath, 'utf8');

    const removeIdsWithPrefixPaths = (options.removeIdsWithPrefix ?? []).map(removePrefix => isXliffV2 ? `/xliff/file/unit[starts-with(@id,"${removePrefix}")]` : `/xliff/file/body/trans-unit[starts-with(@id,"${removePrefix}")]`);
    const removeContextPaths = (includeContext: boolean) => includeContext ? [] : [isXliffV2 ? '/xliff/file/unit/notes' : '/xliff/file/body/trans-unit/context-group'];

    const removePathsSourceFile = [
        ...(removeContextPaths(options.includeContext === true || options.includeContext === 'sourceFileOnly')),
        ...removeIdsWithPrefixPaths
    ];
    const removePathsTargetFiles = [
        ...(removeContextPaths(options.includeContext === true)),
        ...removeIdsWithPrefixPaths
    ];
    const idPath = isXliffV2 ? '/xliff/file/unit/@id' : '/xliff/file/body/trans-unit/@id';
    const sort: Options['sort'] = options.sort ?? 'stableAppendNew';
    const normalizedTranslationSourceFile = xmlNormalize({
        in: translationSourceFile,
        trim: options.trim ?? false,
        normalizeWhitespace: options.collapseWhitespace ?? true,
        sortPath: sort === 'idAsc' ? idPath : undefined,
        removePath: removePathsSourceFile
    });

    let idMapping: { [id: string]: string } = {};

    for (const targetFile of options.targetFiles) {
        const targetPath = join(normalize(outputPath), targetFile);
        context.logger.info(`merge and normalize ${targetPath} ...`);
        const translationTargetFile = await readFileIfExists(targetPath) ?? '';
        const [mergedTarget, mapping] = mergeWithMapping(normalizedTranslationSourceFile, translationTargetFile, {
            ...options,
            syncTargetsWithInitialState: true,
            sourceLanguage: targetFile === options.sourceLanguageTargetFile
        }, targetPath);
        const normalizedTarget = xmlNormalize({
            in: mergedTarget,
            trim: options.trim ?? false,
            normalizeWhitespace: options.collapseWhitespace,
            // no sorting for 'stableAppendNew' as this is the default merge behaviour:
            sortPath: sort === 'idAsc' ? idPath : undefined,
            removePath: removePathsTargetFiles
        });
        await fs.writeFile(targetPath, normalizedTarget);
        idMapping = {...idMapping, ...mapping};
    }

    if (sort === 'stableAppendNew' && translationSourceFileOriginal) {
        const normalizedTranslationSourceFileWithStableSorting = resetSortOrder(translationSourceFileOriginal, normalizedTranslationSourceFile, idPath, idMapping, options);
        await fs.writeFile(sourcePath, normalizedTranslationSourceFileWithStableSorting);
    } else {
        await fs.writeFile(sourcePath, normalizedTranslationSourceFile);
    }

    context.logger.info('finished i18n merging and normalizing');
    return {success: true};
}
