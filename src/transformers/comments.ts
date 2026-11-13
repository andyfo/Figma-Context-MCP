import type { Comment, Node as FigmaDocumentNode, Rectangle, Vector } from "@figma/rest-api-spec";
import type { SimplifiedNode } from "~/extractors/types.js";
import { isVisible } from "~/utils/common.js";

export interface SimplifiedComment {
  by: string;
  // Day the thread started (YYYY-MM-DD): enough to tell old feedback from new.
  at: string;
  text: string;
  // Resolved threads are kept, not dropped: they record decisions, but the
  // change they asked for may already be in the design.
  resolved?: true;
  replies?: SimplifiedCommentReply[];
}

export interface SimplifiedCommentReply {
  by: string;
  text: string;
}

type Thread = { root: Comment; replies: Comment[] };
type Point = { x: number; y: number };

// Layers a comment can be "about". A pin that lands on a leaf (text, image,
// vector) is read as being about the container around it: leaves are often
// full-bleed backgrounds, and the container is the unit a developer builds.
const TARGET_TYPES = new Set([
  "FRAME",
  "GROUP",
  "SECTION",
  "COMPONENT",
  "COMPONENT_SET",
  "INSTANCE",
]);

/**
 * Attach comment threads to the simplified nodes they're about. Returns the
 * threads that aren't pinned to any layer when `keepUnpinned` is set, and an
 * empty list otherwise.
 *
 * Figma pins a comment to a frame (often a whole page design) plus an offset
 * inside it, not to the layer under the pin. Attaching every thread to that
 * frame would bury section-level feedback at the top of the page, so the
 * frame + offset is turned back into a canvas point and followed down the raw
 * tree to the deepest container under it: the layer the designer clicked on.
 * That needs raw geometry the simplified tree no longer has, which is why this
 * runs as a post-pass over both trees rather than as an extractor.
 *
 * Threads pinned to a frame outside the fetched part are left out: without
 * that frame's position there's no telling where they point.
 */
export function attachComments(
  nodes: SimplifiedNode[],
  rawRoots: FigmaDocumentNode[],
  comments: Comment[],
  { keepUnpinned }: { keepUnpinned: boolean },
): SimplifiedComment[] {
  const rawById = indexById(rawRoots, (node) => ("children" in node ? node.children : undefined));
  const simplifiedById = indexById(nodes, (node) => node.children);

  const unpinned: Thread[] = [];
  const placed = new Map<SimplifiedNode, Thread[]>();

  for (const thread of buildThreads(comments)) {
    // Typed as always present, but the API sends null on some comments; treat
    // those like canvas pins rather than trusting the type.
    const pin = thread.root.client_meta as Comment["client_meta"] | null;
    if (!pin || !("node_id" in pin)) {
      if (keepUnpinned) unpinned.push(thread);
      continue;
    }

    const pinnedNode = rawById.get(pin.node_id);
    if (!pinnedNode) continue;

    // Deepest first, so a target cut from the output (depth limit, collapsed
    // SVG container) falls back to its nearest ancestor that made it in.
    const target = layersUnderPin(pinnedNode, pin.node_offset)
      .reverse()
      .map((node) => simplifiedById.get(node.id))
      .find((node) => node !== undefined);
    if (!target) continue;

    const threads = placed.get(target) ?? [];
    threads.push(thread);
    placed.set(target, threads);
  }

  for (const [node, threads] of placed) {
    node.comments = threads.sort(openFirstThenOldest).map(simplifyThread);
  }
  return unpinned.sort(openFirstThenOldest).map(simplifyThread);
}

function buildThreads(comments: Comment[]): Thread[] {
  const threads = new Map<string, Thread>();
  for (const comment of comments) {
    if (!comment.parent_id) threads.set(comment.id, { root: comment, replies: [] });
  }
  for (const comment of comments) {
    if (comment.parent_id) threads.get(comment.parent_id)?.replies.push(comment);
  }
  for (const thread of threads.values()) {
    thread.replies.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  return [...threads.values()];
}

/**
 * The pinned layer followed by each container under the pin, outermost first.
 */
function layersUnderPin(pinnedNode: FigmaDocumentNode, offset: Vector): FigmaDocumentNode[] {
  const path = [pinnedNode];
  const box = boundsOf(pinnedNode);
  if (!box) return path;

  const point = { x: box.x + offset.x, y: box.y + offset.y };
  let hit = topmostChildAt(pinnedNode, point);
  while (hit && TARGET_TYPES.has(hit.type)) {
    path.push(hit);
    hit = topmostChildAt(hit, point);
  }
  return path;
}

function topmostChildAt(node: FigmaDocumentNode, point: Point): FigmaDocumentNode | undefined {
  if (!("children" in node)) return undefined;
  // Later children are drawn on top, so the last one under the point is the
  // one the designer saw and clicked.
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i];
    const box = boundsOf(child);
    if (isVisible(child) && box && contains(box, point)) return child;
  }
  return undefined;
}

function boundsOf(node: FigmaDocumentNode): Rectangle | undefined {
  return ("absoluteBoundingBox" in node && node.absoluteBoundingBox) || undefined;
}

function contains(box: Rectangle, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

function openFirstThenOldest(a: Thread, b: Thread): number {
  const byResolved = Number(Boolean(a.root.resolved_at)) - Number(Boolean(b.root.resolved_at));
  return byResolved || a.root.created_at.localeCompare(b.root.created_at);
}

function simplifyThread({ root, replies }: Thread): SimplifiedComment {
  return {
    by: root.user.handle,
    at: root.created_at.slice(0, 10),
    text: root.message,
    ...(root.resolved_at ? { resolved: true as const } : {}),
    ...(replies.length > 0
      ? { replies: replies.map((reply) => ({ by: reply.user.handle, text: reply.message })) }
      : {}),
  };
}

function indexById<T extends { id: string }>(
  roots: T[],
  childrenOf: (node: T) => T[] | undefined,
): Map<string, T> {
  const byId = new Map<string, T>();
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    byId.set(node.id, node);
    stack.push(...(childrenOf(node) ?? []));
  }
  return byId;
}
