import ts from "typescript";
import { readFileSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";

const sourceFile = (source: string, file = "source.tsx") => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
export function jsxSnippet(source: string, id: string, max = 600): string {
  const sf = sourceFile(source);
  let result = "";
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      if (`${pos.line + 1}:${pos.character + 1}` === id) result = source.slice(node.getStart(sf), node.end);
    }
    if (!result) ts.forEachChild(node, visit);
  };
  visit(sf);
  return result.length > max ? result.slice(0, max) + "…" : result;
}

export function tsxInfo(source: string, file: string) {
  const sf = sourceFile(source, file), imports: { name: string; from: string }[] = [], props: string[] = [], defaults: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const c = node.importClause, from = node.moduleSpecifier.text;
      if (c?.name) imports.push({ name: c.name.text, from });
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings))
        for (const e of c.namedBindings.elements) imports.push({ name: e.name.text, from });
    }
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && /Props$/.test(node.name.text)) props.push(node.getText(sf));
    if (ts.isBindingElement(node) && node.initializer) defaults.push(node.getText(sf));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const preview = sf.statements.some(node => {
    if (ts.isExportDeclaration(node)) return !node.isTypeOnly && node.exportClause && ts.isNamedExports(node.exportClause)
      && node.exportClause.elements.some(e => !e.isTypeOnly && e.name.text === "Preview");
    if (!ts.canHaveModifiers(node)) return false;
    const modifiers = ts.getModifiers(node);
    if (!modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) || modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword || m.kind === ts.SyntaxKind.DeclareKeyword)) return false;
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text === "Preview";
    return ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === "Preview");
  });
  return { header: source.match(/^\s*(\/\*\*[\s\S]*?\*\/)/)?.[1] ?? "", imports, props, defaults, preview };
}

export function directComponents(root: string, file: string, index: Map<string, string>): string[] {
  const info = tsxInfo(readFileSync(resolve(root, file), "utf8"), file);
  const found = new Set<string>();
  for (const dep of info.imports) {
    if (!dep.from.startsWith(".")) continue;
    const base = resolve(dirname(resolve(root, file)), dep.from);
    for (const [name, path] of index) if ([base, base + ".tsx", resolve(base, "index.tsx")].includes(resolve(root, path))) found.add(name);
  }
  return [...found];
}

/** JSX locations come from the original AST, before any source transformation. */
export function instrument(source: string, file: string): string {
  const sf = sourceFile(source, file);
  const result = ts.transpileModule(source, {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, jsxFactory: "__cdCreateElement", jsxFragmentFactory: "__cdFragment", sourceMap: false },
    transformers: { before: [ctx => input => {
      const visit: ts.Visitor = node => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const pos = sf.getLineAndCharacterOfPosition(node.getStart(input));
          const loc = `${pos.line + 1}:${pos.character + 1}`;
          const tag = node.tagName.getText(input), intrinsic = /^[a-z]/.test(tag) && !tag.includes(".");
          const extra = intrinsic ? { "data-cd-file": file, "data-cd-id": loc } : { __cdSource: `${file}:${loc}` };
          const attrs = ctx.factory.updateJsxAttributes(node.attributes, [...node.attributes.properties,
            ...Object.entries(extra).map(([key, val]) => ctx.factory.createJsxAttribute(ctx.factory.createIdentifier(key), ctx.factory.createStringLiteral(val)))]);
          node = ts.isJsxOpeningElement(node) ? ctx.factory.updateJsxOpeningElement(node, node.tagName, node.typeArguments, attrs)
            : ctx.factory.updateJsxSelfClosingElement(node, node.tagName, node.typeArguments, attrs);
        }
        return ts.visitEachChild(node, visit, ctx);
      };
      return ts.visitNode(input, visit) as ts.SourceFile;
    }] },
  });
  const errors = (result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: x => x, getCurrentDirectory: () => ".", getNewLine: () => "\n" }));
  return 'import {createElement as __cdCreateElement, Fragment as __cdFragment} from "cdesign:runtime";\n' + result.outputText;
}

/** Preserve relative module/asset references when check --fix moves a preview. */
export function relocateImports(source: string, from: string, to: string): string {
  const sf = sourceFile(source, from), edits: {start: number; end: number; text: string}[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) && node.text.startsWith(".")) {
      const p = node.parent;
      const module = ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === node)
        || (ts.isCallExpression(p) && p.arguments[0] === node && (p.expression.kind === ts.SyntaxKind.ImportKeyword || p.expression.getText(sf) === "require"))
        || (ts.isNewExpression(p) && p.arguments?.[0] === node && p.expression.getText(sf) === "URL");
      if (module) {
        let path = relative(dirname(to), resolve(dirname(from), node.text)).split(sep).join("/");
        if (!path.startsWith(".")) path = "./" + path;
        edits.push({start:node.getStart(sf), end:node.end, text:JSON.stringify(path)});
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const edit of edits.sort((a,b) => b.start-a.start)) source = source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  return source;
}
