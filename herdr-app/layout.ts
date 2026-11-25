// Layout edits for the installer. Herdr shows one layout at a time, so several mods often
// share one personal layout. The rule that lets them: a mod owns only its own blocks, and
// when it rebuilds a layout from Herdr's main, it keeps every block belonging to a mod Herdr
// doesn't ship (another mod's), in the same spot. Hand-edit checks ignore those blocks too.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LayoutNode {
  id?: string;
  type: string;
  size?: { px?: number; weight?: number };
  content?: { mod?: string; [key: string]: unknown };
  children?: LayoutNode[];
  [key: string]: unknown;
}

/** A block taken out of a layout, and where it was. */
export interface Removed {
  node: LayoutNode;
  parent: string | undefined;
  after: string | undefined;
  before: string | undefined;
}

/** What Herdr ships, from its installed.json: mod names, and layouts as `layout:<name>`.
 *  Null without the file: then nothing can be told apart, so nothing counts as foreign. */
export function shipped(home: string): { mods: Set<string>; layouts: Set<string> } | null {
  const path = join(home, "installed.json");
  if (!existsSync(path)) return null;
  const names = Object.keys(JSON.parse(readFileSync(path, "utf8")));
  return {
    mods: new Set(names.filter((name) => !name.startsWith("layout:"))),
    layouts: new Set(names.filter((name) => name.startsWith("layout:")).map((name) => name.slice(7))),
  };
}

/** A block showing a mod that is neither Herdr's nor `own`. Without the shipped list, none. */
export function foreignTo(own: string, shippedMods: Set<string> | null) {
  return (node: LayoutNode) => {
    if (!shippedMods) return false;
    const mod = node.content?.mod;
    return node.type === "block" && typeof mod === "string" && mod !== own && !shippedMods.has(mod);
  };
}

export function findNode(node: LayoutNode, id: string): LayoutNode | null {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** A copy of the layout without the matching blocks, and the blocks with where they were. */
export function strip(tree: LayoutNode, match: (node: LayoutNode) => boolean): { tree: LayoutNode; removed: Removed[] } {
  const removed: Removed[] = [];
  const walk = (node: LayoutNode): LayoutNode => {
    if (!node.children) return node;
    const kept: LayoutNode[] = [];
    node.children.forEach((child, index) => {
      if (match(child)) {
        removed.push({
          node: child,
          parent: node.id,
          after: node.children![index - 1]?.id,
          before: node.children![index + 1]?.id,
        });
      } else {
        kept.push(walk(child));
      }
    });
    return { ...node, children: kept };
  };
  return { tree: walk(structuredClone(tree)), removed };
}

/** Puts removed blocks back beside the same neighbours. Returns the ones with nowhere to go. */
export function reinsert(tree: LayoutNode, removed: Removed[]): Removed[] {
  const lost: Removed[] = [];
  for (const entry of removed) {
    if (entry.node.id && findNode(tree, entry.node.id)) continue;
    const parent = entry.parent ? findNode(tree, entry.parent) : null;
    if (!parent?.children) {
      lost.push(entry);
      continue;
    }
    const siblings = parent.children;
    const after = entry.after ? siblings.findIndex((child) => child.id === entry.after) : -1;
    const before = entry.before ? siblings.findIndex((child) => child.id === entry.before) : -1;
    const index = after !== -1 ? after + 1 : before !== -1 ? before : siblings.length;
    siblings.splice(index, 0, entry.node);
  }
  return lost;
}

/** Adds a block above the sidebar's Settings / Add machine footer. False if there's no footer. */
export function addAboveSidebarFooter(tree: LayoutNode, block: LayoutNode): boolean {
  const children = tree.children ?? [];
  const index = children.findIndex((child) => child.id === "sidebar-footer");
  if (index === -1) return children.some((child) => addAboveSidebarFooter(child, block));
  children.splice(index, 0, block);
  return true;
}

/** Puts a block at the right end of Herdr's tab bar: the `tabs` block moves into a fixed row
 *  (with this id, at the tab bar's size) beside it. False if there's no tab bar or it's done. */
export function addBesideTabs(tree: LayoutNode, block: LayoutNode, rowId: string): boolean {
  if (findNode(tree, rowId) || (block.id && findNode(tree, block.id))) return false;
  const walk = (node: LayoutNode): boolean => {
    const children = node.children ?? [];
    const index = children.findIndex((child) => child.id === "tabs");
    if (index === -1) return children.some(walk);
    const tabs = children[index]!;
    children[index] = {
      id: rowId, type: "row", size: tabs.size, resizable: false,
      children: [{ ...tabs, size: { weight: 1 } }, block],
    };
    return true;
  };
  return walk(tree);
}

/** Undoes addBesideTabs: the tab bar goes back where the row was, at the row's size. */
export function removeBesideTabs(tree: LayoutNode, rowId: string): boolean {
  const walk = (node: LayoutNode): boolean => {
    const children = node.children ?? [];
    const index = children.findIndex((child) => child.id === rowId);
    if (index === -1) return children.some(walk);
    const row = children[index]!;
    const tabs = row.children?.find((child) => child.id === "tabs");
    if (tabs) children[index] = { ...tabs, size: row.size };
    else children.splice(index, 1);
    return true;
  };
  return walk(tree);
}

/** Removes the block with this id. True if there was one. */
export function removeNode(tree: LayoutNode, id: string): boolean {
  const children = tree.children ?? [];
  const index = children.findIndex((child) => child.id === id);
  if (index !== -1) {
    children.splice(index, 1);
    return true;
  }
  return children.some((child) => removeNode(child, id));
}
