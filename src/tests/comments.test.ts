import { describe, expect, it } from "vitest";
import type {
  Comment,
  GetFileNodesResponse,
  GetFileResponse,
  Node as FigmaNode,
} from "@figma/rest-api-spec";
import { allExtractors } from "~/extractors/built-in.js";
import { simplifyRawFigmaObject } from "~/extractors/design-extractor.js";
import type { SimplifiedNode } from "~/extractors/types.js";
import { getFigmaData } from "~/services/get-figma-data.js";
import type { FigmaService } from "~/services/figma.js";
import { tagError } from "~/utils/error-meta.js";

function makeNode(overrides: Record<string, unknown>): FigmaNode {
  return { visible: true, ...overrides } as unknown as FigmaNode;
}

function box(x: number, y: number, width: number, height: number) {
  return { absoluteBoundingBox: { x, y, width, height } };
}

// A page design placed away from the canvas origin, so a placement that
// forgets to add the frame's own position lands on the wrong layer:
//   Page design (frame the comments are pinned to)
//   ├── Background  full-bleed rectangle, drawn first (bottom)
//   ├── Hero
//   │   └── CTA
//   │       └── Label (text)
//   └── Footer
const pageDesign = makeNode({
  id: "10:1",
  name: "Page design",
  type: "FRAME",
  ...box(1000, 0, 1000, 1000),
  children: [
    makeNode({ id: "10:2", name: "Background", type: "RECTANGLE", ...box(1000, 0, 1000, 1000) }),
    makeNode({
      id: "10:3",
      name: "Hero",
      type: "FRAME",
      ...box(1000, 0, 1000, 400),
      children: [
        makeNode({
          id: "10:4",
          name: "CTA",
          type: "FRAME",
          ...box(1100, 300, 200, 50),
          children: [
            makeNode({
              id: "10:5",
              name: "Label",
              type: "TEXT",
              characters: "Book a call",
              ...box(1110, 310, 100, 20),
            }),
          ],
        }),
      ],
    }),
    makeNode({ id: "10:6", name: "Footer", type: "FRAME", ...box(1000, 800, 1000, 200) }),
  ],
});

function comment(fields: {
  id: string;
  by: string;
  at: string;
  message: string;
  pin?: unknown;
  parentId?: string;
  resolved?: boolean;
}): Comment {
  return {
    id: fields.id,
    file_key: "abc123",
    parent_id: fields.parentId ?? "",
    user: { id: `u-${fields.by}`, handle: fields.by, img_url: "" },
    created_at: `${fields.at}T09:00:00Z`,
    resolved_at: fields.resolved ? `${fields.at}T17:00:00Z` : null,
    message: fields.message,
    order_id: "1",
    reactions: [],
    client_meta: fields.pin ?? null,
  } as unknown as Comment;
}

// Pins are relative to the frame they're on, as Figma sends them.
const onCta = { node_id: "10:1", node_offset: { x: 150, y: 320 } };
const onBackground = { node_id: "10:1", node_offset: { x: 500, y: 600 } };

const comments = [
  comment({ id: "1", by: "Ana", at: "2026-05-02", message: "Make this **bigger**", pin: onCta }),
  comment({ id: "2", by: "Ben", at: "2026-05-03", message: "Agreed, 48px", parentId: "1" }),
  comment({
    id: "3",
    by: "Ana",
    at: "2026-04-01",
    message: "120px between sections",
    pin: onBackground,
    resolved: true,
  }),
  comment({
    id: "4",
    by: "Cleo",
    at: "2026-04-20",
    message: "Old copy",
    pin: onCta,
    resolved: true,
  }),
  comment({
    id: "5",
    by: "Ben",
    at: "2026-04-21",
    message: "Other frame",
    pin: { node_id: "99:9", node_offset: { x: 1, y: 1 } },
  }),
  comment({ id: "6", by: "Cleo", at: "2026-04-22", message: "On the canvas", pin: { x: 5, y: 5 } }),
];

function nodesResponse(document: FigmaNode): GetFileNodesResponse {
  return {
    name: "Test file",
    nodes: { [document.id]: { document, components: {}, componentSets: {}, styles: {} } },
  } as unknown as GetFileNodesResponse;
}

function fileResponse(frame: FigmaNode): GetFileResponse {
  return {
    name: "Test file",
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children: [{ id: "0:1", name: "Page 1", type: "CANVAS", children: [frame] }],
    },
    components: {},
    componentSets: {},
    styles: {},
  } as unknown as GetFileResponse;
}

function findNode(nodes: SimplifiedNode[], id: string): SimplifiedNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = node.children && findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

function commentedIds(nodes: SimplifiedNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.comments ? [node.id] : []),
    ...commentedIds(node.children ?? []),
  ]);
}

describe("comments", () => {
  it("places each thread on the container under its pin, open threads first", async () => {
    const design = await simplifyRawFigmaObject(nodesResponse(pageDesign), allExtractors, {
      comments,
    });

    // The pin is on the CTA's label; a text leaf isn't a target, so the CTA is.
    expect(findNode(design.nodes, "10:4")?.comments).toEqual([
      {
        by: "Ana",
        at: "2026-05-02",
        text: "Make this **bigger**",
        replies: [{ by: "Ben", text: "Agreed, 48px" }],
      },
      { by: "Cleo", at: "2026-04-20", text: "Old copy", resolved: true },
    ]);
    // Only the full-bleed background is under this pin: it stays on the frame.
    expect(findNode(design.nodes, "10:1")?.comments).toEqual([
      { by: "Ana", at: "2026-04-01", text: "120px between sections", resolved: true },
    ]);
    // The thread on a frame outside this read and the canvas thread are left out.
    expect(commentedIds(design.nodes)).toEqual(["10:1", "10:4"]);
    expect(design.comments).toBeUndefined();
  });

  it("keeps canvas threads for whole-file reads", async () => {
    const design = await simplifyRawFigmaObject(fileResponse(pageDesign), allExtractors, {
      comments,
    });

    expect(design.comments).toEqual([{ by: "Cleo", at: "2026-04-22", text: "On the canvas" }]);
    expect(commentedIds(design.nodes)).toEqual(["10:1", "10:4"]);
  });

  it("falls back to the nearest layer that made it into a depth-limited read", async () => {
    const design = await simplifyRawFigmaObject(nodesResponse(pageDesign), allExtractors, {
      comments,
      maxDepth: 1,
    });

    expect(findNode(design.nodes, "10:4")).toBeUndefined();
    expect(findNode(design.nodes, "10:3")?.comments?.map((c) => c.text)).toEqual([
      "Make this **bigger**",
      "Old copy",
    ]);
  });

  it("still returns the design, with a note, when comments can't be read", async () => {
    const figmaService = {
      getRawNode: async () => ({ data: nodesResponse(pageDesign), rawSize: 1 }),
      getComments: async () => tagError(new Error("Forbidden"), { http_status: 403 }),
    } as unknown as FigmaService;

    const { formatted } = await getFigmaData(
      figmaService,
      { fileKey: "abc123", nodeId: "10:1" },
      "tree",
    );

    expect(formatted).toContain("NOTES:");
    expect(formatted).toContain("this Figma token can't read comments");
    expect(formatted).toContain("#10:4");
    expect(formatted).not.toContain("comments=");
  });
});
