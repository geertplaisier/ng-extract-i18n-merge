import {XmlDocument, XmlElement, XmlNode, XmlTextNode} from 'xmldoc';
import {TranslationFile} from './translationFileModels';
import {Options} from '../options';


const XML_DECLARATION_MATCHER = /^<\?xml [^>]*>\s*/i;

export function fromXlf2(xlf2: string): TranslationFile {
    const xmlDeclaration = xlf2.match(XML_DECLARATION_MATCHER)?.[0];
    const doc = new XmlDocument(xlf2);
    const file = doc.childNamed('file')!;
    const units = file.children
        .filter((n): n is XmlElement => n.type === 'element')
        .map(unit => {
            const segment = unit.childNamed('segment')!;
            const notes = unit.childNamed('notes');
            return {
                id: unit.attr.id,
                source: toString(...segment.childNamed('source')!.children),
                target: segment.childNamed('target') ? toString(...segment.childNamed('target')!.children) : undefined,
                state: segment.attr.state,
                meaning: notes?.childWithAttribute('category', 'meaning')?.val,
                description: notes?.childWithAttribute('category', 'description')?.val,
                locations: notes?.children
                    .filter((n): n is XmlElement => n.type === 'element' && n.attr.category === 'location')
                    .map(note => {
                        const [file, lines] = note.val.split(':', 2);
                        const [lineStart, lineEnd] = lines.split(',', 2);
                        return {
                            file,
                            lineStart: parseInt(lineStart, 10),
                            lineEnd: lineEnd !== undefined ? parseInt(lineEnd, 10) : undefined
                        };
                    }) ?? []
            };
        });
    return new TranslationFile(units, doc.attr.srcLang, doc.attr.trgLang, xmlDeclaration);
}

export function fromXlf1(xlf1: string): TranslationFile {
    const xmlDeclaration = xlf1.match(XML_DECLARATION_MATCHER)?.[0];
    const doc = new XmlDocument(xlf1);
    const file = doc.childNamed('file')!;
    const units = file.childNamed('body')!.children
        .filter((n): n is XmlElement => n.type === 'element')
        .map(unit => {
            const notes = unit.childrenNamed('note');
            const target = unit.childNamed('target');
            return {
                id: unit.attr.id,
                source: toString(...unit.childNamed('source')!.children),
                target: target ? toString(...target.children) : undefined,
                state: target?.attr.state,
                meaning: notes?.find(note => note.attr.from === 'meaning')?.val,
                description: notes?.find(note => note.attr.from === 'description')?.val,
                locations: unit.childrenNamed('context-group')
                    .map(contextGroup => ({
                        file: contextGroup.childWithAttribute('context-type', 'sourcefile')!.val,
                        lineStart: parseInt(contextGroup.childWithAttribute('context-type', 'linenumber')!.val, 10)
                    })) ?? []
            };
        });
    return new TranslationFile(units, file.attr['source-language'], file.attr['target-language'], xmlDeclaration);
}

function toString(...nodes: XmlNode[]): string {
    return nodes.map(n => n.toString({preserveWhitespace: true, compressed: true})).join('');
}

export function toXlf2(translationFile: TranslationFile, options: Pick<Options, 'prettyNestedTags'>): string {
    const doc = new XmlDocument(`<xliff version="2.0" xmlns="urn:oasis:names:tc:xliff:document:2.0" srcLang="${translationFile.sourceLang}">
    <file id="ngi18n" original="ng.template">
    </file>
</xliff>`);
    if (translationFile.targetLang) {
        doc.attr.trgLang = translationFile.targetLang;
    }
    const file = doc.childNamed('file')!;
    file.children = translationFile.units.map(unit => {
        const u = new XmlDocument(`<unit id="${unit.id}"><segment><source>${unit.source}</source></segment></unit>`);
        const segment = u.childNamed('segment')!;
        if (unit.target !== undefined) {
            segment.children.push(new XmlDocument(`<target>${unit.target}</target>`));
        }
        if (unit.state) {
            segment.attr.state = unit.state;
        }
        if (unit.meaning !== undefined || unit.description !== undefined || unit.locations.length) {
            const notes = new XmlDocument('<notes></notes>');
            u.children.splice(0, 0, notes);
            notes.children.push(...unit.locations.map(location => new XmlDocument(`<note category="location">${location.file}:${location.lineStart}${location.lineEnd ? ',' + location.lineEnd : ''}</note>`)));
            if (unit.description !== undefined) {
                notes.children.push(new XmlDocument(`<note category="description">${unit.description}</note>`));
            }
            if (unit.meaning !== undefined) {
                notes.children.push(new XmlDocument(`<note category="meaning">${unit.meaning}</note>`));
            }
        }

        updateFirstAndLastChild(u);
        return u;
    });
    updateFirstAndLastChild(doc);
    return (translationFile.xmlHeader ?? '') + pretty(doc, options);
}

export function toXlf1(translationFile: TranslationFile, options: Pick<Options, 'prettyNestedTags'>): string {
    const doc = new XmlDocument(`<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
    <file source-language="${translationFile.sourceLang}"  datatype="plaintext" original="ng2.template">
    <body></body>
    </file>
</xliff>`);
    const file = doc.childNamed('file')!;
    if (translationFile.targetLang !== undefined) {
        // assure "correct" order:
        file.attr = {
            'source-language': translationFile.sourceLang,
            'target-language': translationFile.targetLang,
            datatype: 'plaintext',
            original: 'ng2.template'
        };
    }
    const body = file.childNamed('body')!;
    body.children = translationFile.units.map(unit => {
        const transUnit = new XmlDocument(`<trans-unit id="${unit.id}" datatype="html">
        <source>${unit.source}</source>
</trans-unit>`);
        if (unit.target !== undefined) {
            const target = new XmlDocument(`<target>${unit.target}</target>`);
            if (unit.state !== undefined) {
                target.attr.state = unit.state;
            }
            transUnit.children.push(target);
        }
        if (unit.description !== undefined) {
            transUnit.children.push(new XmlDocument(`<note priority="1" from="description">${unit.description}</note>`));
        }
        if (unit.meaning !== undefined) {
            transUnit.children.push(new XmlDocument(`<note priority="1" from="meaning">${unit.meaning}</note>`));
        }
        if (unit.locations.length) {
            transUnit.children.push(...unit.locations.map(location => new XmlDocument(`<context-group purpose="location">
            <context context-type="sourcefile">${location.file}</context>
            <context context-type="linenumber">${location.lineStart}</context>
        </context-group>`)));
        }
        updateFirstAndLastChild(body);
        return transUnit;
    });
    return (translationFile.xmlHeader ?? '') + pretty(doc, options);
}

function updateFirstAndLastChild(u: XmlElement) {
    u.firstChild = u.children[0];
    u.lastChild = u.children[u.children.length - 1];
}

function isWhiteSpace(node: XmlNode): node is XmlTextNode {
    return node.type === 'text' && !!node.text.match(/^\s*$/);
}

function isSourceOrTarget<T extends XmlDocument | XmlElement>(node: T) {
    return node.name === 'source' || node.name === 'target';
}

/// removes all whitespace text nodes that are not mixed with other nodes. For source/target nodes whitespace is unchanged.
function removeWhitespace<T extends XmlDocument | XmlElement>(node: T): void {
    if (node.type === 'element' && isSourceOrTarget(node)) {
        return;
    }
    if (node.type === 'element' && node.children.every(n => n.type !== 'text' || isWhiteSpace(n))) {
        node.children = node.children.filter(c => !isWhiteSpace(c));
        updateFirstAndLastChild(node);
    }
    node.children.filter((n): n is XmlElement => n.type === 'element').forEach(e => removeWhitespace(e));
}

/// format with 2 spaces indentation, except for source/target nodes: there nested nodes are assured to keep (non-)whitespaces (potentially collapsed/expanded)
function pretty(doc: XmlDocument, options: Pick<Options, 'prettyNestedTags'>) {
    removeWhitespace(doc);
    addPrettyWhitespace(doc, 0, options);
    return doc.toString({preserveWhitespace: true, compressed: true});
}

function indentChildren(doc: XmlElement, indent: number) {
    for (let i = doc.children.length - 1; i >= 0; i--) {
        doc.children.splice(i, 0, new XmlTextNode('\n' + '  '.repeat(indent + 1)))
    }
    doc.children.push(new XmlTextNode('\n' + '  '.repeat(indent)));
    updateFirstAndLastChild(doc);
}

function addPrettyWhitespace(doc: XmlElement, indent: number, options: Pick<Options, 'prettyNestedTags'>, sourceOrTarget = false) {
    if (isSourceOrTarget(doc) || sourceOrTarget) {
        if (options.prettyNestedTags && doc.children.length && doc.children.every(c => isWhiteSpace(c) || c.type === 'element')) {
            doc.children = doc.children.filter(c => !isWhiteSpace(c));
            updateFirstAndLastChild(doc)
            indentChildren(doc, indent);
            doc.children.forEach(c => c.type === 'element' ? addPrettyWhitespace(c, indent + 1, options, true) : null);
        }
        return;
    }

    if (doc.children.length && doc.children.some(e => e.type === 'element')) {
        indentChildren(doc, indent);
        doc.children.forEach(c => c.type === 'element' ? addPrettyWhitespace(c, indent + 1, options) : null);
    }
}
