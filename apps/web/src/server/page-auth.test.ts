/**
 * Every page, generateMetadata and route handler under app/(app) checks the session itself.
 *
 * The (app) layout's requireUser() is not enough: on a client navigation Next.js renders only the
 * segments below the router state the client sends (the `Next-Router-State-Tree` header), so a crafted
 * request can skip the layout entirely, and route handlers never run a layout at all. This test fails
 * when a page or generateMetadata doesn't start with an awaited requireUser()/requireAdmin(), or a route
 * handler doesn't start with an auth call.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../app/(app)", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(ROOT);
const pages = files.filter((f) => f.endsWith("/page.tsx")).map((f) => [relative(ROOT, f), f] as const);
const routes = files.filter((f) => f.endsWith("/route.ts")).map((f) => [relative(ROOT, f), f] as const);

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function functions(sf: ts.SourceFile): ts.FunctionDeclaration[] {
  return sf.statements.filter(ts.isFunctionDeclaration);
}

/** Names exported as `export const x = …` (handlers and metadata must be function declarations, so they're checked). */
function exportedConsts(sf: ts.SourceFile): string[] {
  return sf.statements
    .filter((s): s is ts.VariableStatement => ts.isVariableStatement(s) && hasModifier(s, ts.SyntaxKind.ExportKeyword))
    .flatMap((s) => s.declarationList.declarations.map((d) => d.name.getText(sf)));
}

function firstStatement(fn: ts.FunctionDeclaration, sf: ts.SourceFile): string {
  return fn.body?.statements[0]?.getText(sf) ?? "";
}

/** `await requireUser();`, `const cu = await requireUser();`, `const { via } = await requireAdmin();` */
const SESSION_CHECK = /^(const\s+[^=]+=\s*)?await\s+(requireUser|requireAdmin)\(\);$/;
const ROUTE_CHECK = /\b(requireUser|requireAdmin|getCurrentUser|apiUser)\(/;
const HANDLERS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

describe("app/(app) checks the session in every page", () => {
  it("finds the pages and routes", () => {
    expect(pages.length).toBeGreaterThan(20);
    expect(routes.length).toBeGreaterThan(1);
  });

  it.each(pages)("%s", (_name, file) => {
    const sf = parse(file);
    const page = functions(sf).find((f) => hasModifier(f, ts.SyntaxKind.ExportKeyword) && hasModifier(f, ts.SyntaxKind.DefaultKeyword));
    expect(page, "the default export is a function declaration").toBeDefined();
    expect(firstStatement(page!, sf)).toMatch(SESSION_CHECK);
    expect(exportedConsts(sf)).not.toContain("generateMetadata");
    const meta = functions(sf).find((f) => f.name?.text === "generateMetadata");
    if (meta) expect(firstStatement(meta, sf)).toMatch(SESSION_CHECK);
  });
});

describe("app/(app) checks the session in every route handler", () => {
  it.each(routes)("%s", (_name, file) => {
    const sf = parse(file);
    expect(exportedConsts(sf).filter((n) => HANDLERS.has(n))).toEqual([]);
    const handlers = functions(sf).filter((f) => hasModifier(f, ts.SyntaxKind.ExportKeyword) && HANDLERS.has(f.name?.text ?? ""));
    expect(handlers.length).toBeGreaterThan(0);
    for (const h of handlers) expect(firstStatement(h, sf)).toMatch(ROUTE_CHECK);
  });
});
